#!/usr/bin/env node
/**
 * test_semantic_induction.js — standing qualification harness for Small Lari's
 * native semantic-operator induction loop (scripts/lari_semantic_induction.js).
 *
 * Every candidate operator must pass ALL gates before it counts as learned:
 *   1. Baseline: pre-induction matcher fails the construction (prove it's new).
 *      For constructions whose surface also parses as a broader relation
 *      (counterfactual vs plain conditional), novelty = the specific relation
 *      does not fire.
 *   2. Training: taught examples induce exactly the expected record(s);
 *      re-teaching refines, never forks duplicates.
 *   3. Hidden transfer: 10 unseen examples, new vocabulary/domains, all parse
 *      to the right relation with the right role spans.
 *   4. Negative controls: similar-but-different surfaces correctly refused
 *      (or parsed as the correct OTHER relation for cross-talk checks).
 *   5. Cold reload: model JSON round-trips through disk; operator still fires.
 *   6. Exact ablation: record removed -> capability disappears (proves cause).
 *   7. Regression: all previously induced operators still pass their transfers.
 *
 * Plus: stress suite (multi-clause, competing markers, nesting, paraphrase,
 * near-miss negatives), robustness suite (conflicting evidence, outlier
 * rejection, surface noise, marker collisions, state hardening, scale smoke,
 * refinement), determinism, live-turn demo, runtime hook integration, SHA-256.
 *
 * Scratch models only; live model, research store, and Drive originals are
 * never touched. No commit/push.
 *
 * Run: node scripts/test_semantic_induction.js [--battery]
 *   --battery also runs the full 46-item chat battery as a final regression.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const sem = require(path.join(ROOT, 'scripts', 'lari_semantic_induction.js'));
const BASE_MODEL = path.join(ROOT, 'models', 'lari', 'current', 'swarm-model.json');
const SCRATCH = path.join(process.env.HOME || '/root', 'workspace', 'scratch', 'lari-semantic-induction');
fs.mkdirSync(SCRATCH, { recursive: true });

const RUN_BATTERY = process.argv.includes('--battery');
const T0 = Date.now();

// ---------------------------------------------------------------- data ----
const CONSTRUCTION_TESTS = [
  {
    relation: 'cause', familyId: 'because_front', order: 'marker_first',
    roleNames: ['cause', 'effect'],
    training: [
      { text: 'Because the bridge collapsed, the town was isolated.', kw: { cause: 'bridge collapsed', effect: 'town was isolated' } },
      { text: 'Since the rains never came, the crops failed.', kw: { cause: 'rains never came', effect: 'crops failed' } },
    ],
    expectedMarkers: ['because', 'since'], expectedOrders: ['marker_first'],
    transfer: [
      { text: 'Because the server overheated, the website went offline.', kw: { cause: 'server overheated', effect: 'website went offline' } },
      { text: 'Since the quarterback was injured, the team lost the game.', kw: { cause: 'quarterback was injured', effect: 'team lost' } },
      { text: 'Because the volcano erupted, nearby villages evacuated.', kw: { cause: 'volcano erupted', effect: 'villages evacuated' } },
      { text: 'Since the funding dried up, the laboratory closed.', kw: { cause: 'funding dried up', effect: 'laboratory closed' } },
      { text: 'Because the alarm malfunctioned, the factory stayed open late.', kw: { cause: 'alarm malfunctioned', effect: 'factory stayed open' } },
      { text: 'Since the roads iced over, school was cancelled.', kw: { cause: 'roads iced over', effect: 'school was cancelled' } },
      { text: 'Because of the storm, the match was postponed.', kw: { cause: 'storm', effect: 'match was postponed' } },
      { text: 'Since the batteries died, the flashlight went dark.', kw: { cause: 'batteries died', effect: 'flashlight went dark' } },
      { text: 'Because the chef resigned, the restaurant changed its menu.', kw: { cause: 'chef resigned', effect: 'restaurant changed' } },
      { text: 'Since the river flooded, the bridge was closed.', kw: { cause: 'river flooded', effect: 'bridge was closed' } },
    ],
    negatives: [
      'The because clause confuses beginners.',
      'I like apples and oranges.',
      'Because.',
      'Since Tuesday, the store has been closed.',
      'The reason, because of rain, was delay.',
      'As the sun set, the campers returned.',
    ],
  },
  {
    relation: 'contrast', familyId: 'concessive_front', order: 'marker_first',
    roleNames: ['a', 'b'],
    training: [
      { text: 'Although the desert is hot, the nights are freezing.', kw: { a: 'desert is hot', b: 'nights are freezing' } },
      { text: 'Though the software was expensive, the company bought it.', kw: { a: 'software was expensive', b: 'company bought it' } },
      { text: 'Even though the night was cold, the travelers pressed on.', kw: { a: 'night was cold', b: 'travelers pressed on' } },
    ],
    expectedMarkers: ['although', 'even though', 'though'], expectedOrders: ['marker_first'],
    transfer: [
      { text: 'Although the mountain is tall, the climb was quick.', kw: { a: 'mountain is tall', b: 'climb was quick' } },
      { text: 'Though the soup was salty, the children ate it.', kw: { a: 'soup was salty', b: 'children ate it' } },
      { text: 'Even though the movie was long, the audience stayed.', kw: { a: 'movie was long', b: 'audience stayed' } },
      { text: 'Although the car is old, the engine runs smoothly.', kw: { a: 'car is old', b: 'engine runs smoothly' } },
      { text: 'Though the exam was difficult, she passed with ease.', kw: { a: 'exam was difficult', b: 'she passed' } },
      { text: 'Although the river is wide, the bridge spans it.', kw: { a: 'river is wide', b: 'bridge spans it' } },
      { text: 'Though the hotel was crowded, the staff remained polite.', kw: { a: 'hotel was crowded', b: 'staff remained polite' } },
      { text: 'Even though the winter was harsh, the garden survived.', kw: { a: 'winter was harsh', b: 'garden survived' } },
      { text: 'Although the phone is cheap, the camera is excellent.', kw: { a: 'phone is cheap', b: 'camera is excellent' } },
      { text: 'Though the road was narrow, the bus navigated it.', kw: { a: 'road was narrow', b: 'bus navigated it' } },
    ],
    negatives: [
      'I like apples and oranges.',
      'The although-clause needs a comma.',
      'Although.',
      'He thought although she hesitated.',
      'Though the night was dark',
      'Although it was raining',
    ],
  },
  {
    relation: 'condition', familyId: 'if_front', order: 'marker_first',
    roleNames: ['condition', 'outcome'],
    training: [
      { text: 'If the train is late, we will miss the connection.', kw: { condition: 'train is late', outcome: 'miss the connection' } },
      { text: 'If the dough rises, the bread will be fluffy.', kw: { condition: 'dough rises', outcome: 'bread will be fluffy' } },
    ],
    expectedMarkers: ['if'], expectedOrders: ['marker_first'],
    transfer: [
      { text: 'If the alarm rings, the guards will respond.', kw: { condition: 'alarm rings', outcome: 'guards will respond' } },
      { text: 'If the ice melts, the river will flood.', kw: { condition: 'ice melts', outcome: 'river will flood' } },
      { text: 'If the battery dies, the radio goes silent.', kw: { condition: 'battery dies', outcome: 'radio goes silent' } },
      { text: 'If the wind picks up, the sailors reef the sails.', kw: { condition: 'wind picks up', outcome: 'sailors reef' } },
      { text: 'If the printer jams, the office calls support.', kw: { condition: 'printer jams', outcome: 'office calls support' } },
      { text: 'If the seeds sprout, the farmer transplants them.', kw: { condition: 'seeds sprout', outcome: 'farmer transplants' } },
      { text: 'If the tide rises, the boats float free.', kw: { condition: 'tide rises', outcome: 'boats float' } },
      { text: 'If the code compiles, the tests will run.', kw: { condition: 'code compiles', outcome: 'tests will run' } },
      { text: 'If the fever breaks, the patient can go home.', kw: { condition: 'fever breaks', outcome: 'patient can go home' } },
      { text: 'If the gate opens, the crowd rushes in.', kw: { condition: 'gate opens', outcome: 'crowd rushes in' } },
    ],
    negatives: [
      'I like apples and oranges.',
      'What if we left early?',
      'As if he owned the place, he walked in.',
      'If only.',
      'The if-clause takes a comma.',
      'If it rains',
    ],
  },
  // ---- marker-mid orders (machinery existed, never qualified) ----
  {
    relation: 'cause', familyId: 'because_mid', order: 'marker_mid',
    roleNames: ['cause', 'effect'],
    training: [
      { text: 'The engine overheated because the coolant leaked.', kw: { cause: 'coolant leaked', effect: 'engine overheated' } },
      { text: 'The streets flooded since the river rose.', kw: { cause: 'river rose', effect: 'streets flooded' } },
    ],
    expectedMarkers: ['because', 'since'], expectedOrders: ['marker_mid'],
    transfer: [
      { text: 'The lights went out because the storm hit the lines.', kw: { cause: 'storm hit the lines', effect: 'lights went out' } },
      { text: 'The match was cancelled since the pitch froze.', kw: { cause: 'pitch froze', effect: 'match was cancelled' } },
      { text: 'She missed the bus because the alarm never rang.', kw: { cause: 'alarm never rang', effect: 'missed the bus' } },
      { text: 'The pipes burst since the temperature dropped.', kw: { cause: 'temperature dropped', effect: 'pipes burst' } },
      { text: 'He stayed home because the roads were icy.', kw: { cause: 'roads were icy', effect: 'stayed home' } },
      { text: 'The concert ended early since the singer lost her voice.', kw: { cause: 'singer lost her voice', effect: 'concert ended early' } },
      { text: 'The garden thrived because the spring rains arrived.', kw: { cause: 'spring rains arrived', effect: 'garden thrived' } },
      { text: 'They wore coats since the wind turned cold.', kw: { cause: 'wind turned cold', effect: 'wore coats' } },
      { text: 'The network slowed because the servers were overloaded.', kw: { cause: 'servers were overloaded', effect: 'network slowed' } },
      { text: 'She carried an umbrella since the clouds gathered.', kw: { cause: 'clouds gathered', effect: 'carried an umbrella' } },
    ],
    negatives: [
      "I've lived here since 2019.",
      'The meeting has run since noon.',
      "She's worked here since January.",
      'The because clause confuses beginners.',
      'Because.',
      'I like apples and oranges.',
    ],
  },
  {
    relation: 'contrast', familyId: 'contrast_mid', order: 'marker_mid',
    roleNames: ['a', 'b'],
    training: [
      { text: 'The engine is small but it pulls hard.', kw: { a: 'engine is small', b: 'pulls hard' } },
      { text: 'He was tired yet he kept going.', kw: { a: 'was tired', b: 'kept going' } },
    ],
    expectedMarkers: ['but', 'yet'], expectedOrders: ['marker_mid'],
    transfer: [
      { text: 'The soup is hot but it tastes bland.', kw: { a: 'soup is hot', b: 'tastes bland' } },
      { text: 'She is young yet she leads the team.', kw: { a: 'is young', b: 'leads the team' } },
      { text: 'The hike was long but the views rewarded us.', kw: { a: 'hike was long', b: 'views rewarded us' } },
      { text: 'The car is old yet the engine purrs.', kw: { a: 'car is old', b: 'engine purrs' } },
      { text: 'The exam was hard but she finished early.', kw: { a: 'exam was hard', b: 'finished early' } },
      { text: 'The night was cold yet the campers stayed warm.', kw: { a: 'night was cold', b: 'campers stayed warm' } },
      { text: 'The task is dull but the pay is excellent.', kw: { a: 'task is dull', b: 'pay is excellent' } },
      { text: 'He is quiet yet his ideas carry weight.', kw: { a: 'is quiet', b: 'ideas carry weight' } },
      { text: 'The movie was long but the ending thrilled us.', kw: { a: 'movie was long', b: 'ending thrilled us' } },
      { text: 'The road is narrow yet the bus fits through.', kw: { a: 'road is narrow', b: 'bus fits through' } },
    ],
    negatives: [
      'I like apples and oranges.',
      'But honestly, I agree.',
      'Yet.',
      'The but-clause needs care.',
      'He left, and she stayed.',
      'But she stayed.',
    ],
  },
  {
    relation: 'contrast', familyId: 'while_front', order: 'marker_first',
    roleNames: ['a', 'b'],
    training: [
      { text: 'While the plan is risky, we should try it.', kw: { a: 'plan is risky', b: 'should try it' } },
      { text: 'While I respect your view, I disagree.', kw: { a: 'respect your view', b: 'disagree' } },
    ],
    expectedMarkers: ['while'], expectedOrders: ['marker_first'],
    transfer: [
      { text: 'While the cost is high, the benefits outweigh it.', kw: { a: 'cost is high', b: 'benefits outweigh it' } },
      { text: 'While she doubts the method, she follows the protocol.', kw: { a: 'doubts the method', b: 'follows the protocol' } },
      { text: 'While the evidence is thin, the theory deserves testing.', kw: { a: 'evidence is thin', b: 'theory deserves testing' } },
      { text: 'While he lacks experience, he learns quickly.', kw: { a: 'lacks experience', b: 'learns quickly' } },
      { text: 'While the weather looks grim, the crew will sail.', kw: { a: 'weather looks grim', b: 'crew will sail' } },
      { text: 'While I understand the concern, the data supports us.', kw: { a: 'understand the concern', b: 'data supports us' } },
      { text: 'While the task seems simple, it demands care.', kw: { a: 'task seems simple', b: 'demands care' } },
      { text: 'While they disagree on details, they share the goal.', kw: { a: 'disagree on details', b: 'share the goal' } },
      { text: 'While the night is dark, the path is marked.', kw: { a: 'night is dark', b: 'path is marked' } },
      { text: 'While success is likely, failure remains possible.', kw: { a: 'success is likely', b: 'failure remains possible' } },
    ],
    negatives: [
      'While I was sleeping, the phone rang.',
      'While they were eating, the power went out.',
      'While morning came, we slept.',
      'While.',
      'The while-clause confuses students.',
      'I like apples and oranges.',
    ],
  },
  // ---- counterfactual (narrower than condition; baseline = relation absent) ----
  {
    relation: 'counterfactual', familyId: 'cf_front', order: 'marker_first',
    roleNames: ['antecedent', 'consequent'], baselineAbsent: true,
    training: [
      { text: 'If he had left earlier, he would have arrived on time.', kw: { antecedent: 'had left earlier', consequent: 'would have arrived on time' } },
      { text: 'If the crew had checked the ropes, the tent would have held.', kw: { antecedent: 'had checked the ropes', consequent: 'would have held' } },
    ],
    expectedMarkers: ['if'], expectedOrders: ['marker_first'],
    transfer: [
      { text: 'If she had studied harder, she would have passed the exam.', kw: { antecedent: 'had studied harder', consequent: 'would have passed' } },
      { text: 'If they had left sooner, they would have caught the train.', kw: { antecedent: 'had left sooner', consequent: 'would have caught the train' } },
      { text: 'If the pilot had seen the storm, he would have turned back.', kw: { antecedent: 'had seen the storm', consequent: 'would have turned back' } },
      { text: 'If we had saved more, we would have bought the house.', kw: { antecedent: 'had saved more', consequent: 'would have bought the house' } },
      { text: 'If the alarm had rung, the guards would have responded.', kw: { antecedent: 'had rung', consequent: 'would have responded' } },
      { text: 'If he had taken the job, he would have moved abroad.', kw: { antecedent: 'had taken the job', consequent: 'would have moved abroad' } },
      { text: 'If the rain had stopped, the match would have resumed.', kw: { antecedent: 'had stopped', consequent: 'would have resumed' } },
      { text: 'If she had called sooner, the doctor would have come.', kw: { antecedent: 'had called sooner', consequent: 'would have come' } },
      { text: 'If the bridge had held, the convoy would have crossed.', kw: { antecedent: 'had held', consequent: 'would have crossed' } },
      { text: 'If I had known, I would have helped.', kw: { antecedent: 'had known', consequent: 'would have helped' } },
    ],
    negatives: [
      { text: 'If the train is late, we will miss the connection.', expect: 'condition' },
      'If only he had listened.',
      'What if we had left earlier?',
      { text: 'If he leaves early, he will arrive on time.', expect: 'condition' },
      { text: 'If I were rich, I would travel.', expect: 'condition' },
      'If it rains',
    ],
  },
  {
    relation: 'counterfactual', familyId: 'cf_mid', order: 'marker_mid',
    roleNames: ['antecedent', 'consequent'], baselineAbsent: true,
    training: [
      { text: 'He would have arrived on time if he had left earlier.', kw: { antecedent: 'had left earlier', consequent: 'would have arrived on time' } },
      { text: 'The tent would have held if the crew had checked the ropes.', kw: { antecedent: 'had checked the ropes', consequent: 'would have held' } },
    ],
    expectedMarkers: ['if'], expectedOrders: ['marker_mid'],
    transfer: [
      { text: 'She would have passed the exam if she had studied harder.', kw: { antecedent: 'had studied harder', consequent: 'would have passed' } },
      { text: 'They would have caught the train if they had left sooner.', kw: { antecedent: 'had left sooner', consequent: 'would have caught the train' } },
      { text: 'He would have turned back if the pilot had seen the storm.', kw: { antecedent: 'had seen the storm', consequent: 'would have turned back' } },
      { text: 'We would have bought the house if we had saved more.', kw: { antecedent: 'had saved more', consequent: 'would have bought the house' } },
      { text: 'The guards would have responded if the alarm had rung.', kw: { antecedent: 'had rung', consequent: 'would have responded' } },
      { text: 'He would have moved abroad if he had taken the job.', kw: { antecedent: 'had taken the job', consequent: 'would have moved abroad' } },
      { text: 'The match would have resumed if the rain had stopped.', kw: { antecedent: 'had stopped', consequent: 'would have resumed' } },
      { text: 'The doctor would have come if she had called sooner.', kw: { antecedent: 'had called sooner', consequent: 'would have come' } },
      { text: 'The convoy would have crossed if the bridge had held.', kw: { antecedent: 'had held', consequent: 'would have crossed' } },
      { text: 'I would have helped if I had known.', kw: { antecedent: 'had known', consequent: 'would have helped' } },
    ],
    negatives: [
      'He will arrive on time if he leaves early.',
      'If only.',
      'I like apples and oranges.',
      'He would have arrived.',
      'What if he had left?',
      'He said if he had left.',
    ],
  },
  {
    relation: 'condition', familyId: 'unless_mid', order: 'marker_mid',
    roleNames: ['condition', 'outcome'],
    training: [
      { text: 'The crops will fail unless it rains soon.', kw: { condition: 'it rains', outcome: 'crops will fail' } },
      { text: 'The picnic is cancelled unless the storm passes.', kw: { condition: 'storm passes', outcome: 'picnic is cancelled' } },
    ],
    expectedMarkers: ['unless'], expectedOrders: ['marker_mid'],
    transfer: [
      { text: 'The plants will die unless you water them.', kw: { condition: 'you water them', outcome: 'plants will die' } },
      { text: 'We cannot launch unless the winds calm down.', kw: { condition: 'winds calm down', outcome: 'cannot launch' } },
      { text: 'The deal collapses unless both sides compromise.', kw: { condition: 'both sides compromise', outcome: 'deal collapses' } },
      { text: 'She will miss the flight unless the taxi arrives.', kw: { condition: 'taxi arrives', outcome: 'miss the flight' } },
      { text: 'The engine seizes unless the oil is changed.', kw: { condition: 'oil is changed', outcome: 'engine seizes' } },
      { text: 'They forfeit unless the team fields eleven players.', kw: { condition: 'team fields eleven players', outcome: 'forfeit' } },
      { text: 'The cake burns unless you lower the heat.', kw: { condition: 'you lower the heat', outcome: 'cake burns' } },
      { text: 'He fails the course unless he passes the final.', kw: { condition: 'passes the final', outcome: 'fails the course' } },
      { text: 'The pipes freeze unless the heater runs all night.', kw: { condition: 'heater runs all night', outcome: 'pipes freeze' } },
      { text: 'The show is cancelled unless the rain stops.', kw: { condition: 'rain stops', outcome: 'show is cancelled' } },
    ],
    negatives: [
      'Unless.',
      'The unless-clause takes care.',
      'I like apples and oranges.',
      'Unless it rains',
      'What if we left early?',
      'If only it would rain.',
    ],
  },
  // ---- purpose ----
  {
    relation: 'purpose', familyId: 'to_front', order: 'marker_first',
    roleNames: ['action', 'purpose'],
    training: [
      { text: 'To win the game, they trained hard.', kw: { purpose: 'win the game', action: 'trained hard' } },
      { text: 'To pass the exam, she studied every night.', kw: { purpose: 'pass the exam', action: 'studied every night' } },
    ],
    expectedMarkers: ['to'], expectedOrders: ['marker_first'],
    transfer: [
      { text: 'To catch the bus, he ran down the street.', kw: { purpose: 'catch the bus', action: 'ran down the street' } },
      { text: 'To impress the judges, the chef plated with care.', kw: { purpose: 'impress the judges', action: 'plated with care' } },
      { text: 'To save money, they cooked at home.', kw: { purpose: 'save money', action: 'cooked at home' } },
      { text: 'To find the trail, we followed the river.', kw: { purpose: 'find the trail', action: 'followed the river' } },
      { text: 'To calm the crowd, the mayor spoke slowly.', kw: { purpose: 'calm the crowd', action: 'mayor spoke slowly' } },
      { text: 'To fix the leak, she shut off the water.', kw: { purpose: 'fix the leak', action: 'shut off the water' } },
      { text: 'To learn the song, he practiced daily.', kw: { purpose: 'learn the song', action: 'practiced daily' } },
      { text: 'To reach the summit, the climbers left at dawn.', kw: { purpose: 'reach the summit', action: 'climbers left at dawn' } },
      { text: 'To protect the crops, the farmer built a fence.', kw: { purpose: 'protect the crops', action: 'farmer built a fence' } },
      { text: 'To finish on time, the team skipped lunch.', kw: { purpose: 'finish on time', action: 'team skipped lunch' } },
    ],
    negatives: [
      'To be honest, he is right.',
      'To be fair, the call was close.',
      'To the store, we walked.',
      'I like apples and oranges.',
      'To win.',
      'To be continued.',
    ],
  },
  {
    relation: 'purpose', familyId: 'in_order_to_front', order: 'marker_first',
    roleNames: ['action', 'purpose'],
    training: [
      { text: 'In order to pass the exam, she studied late.', kw: { purpose: 'pass the exam', action: 'studied late' } },
      { text: 'In order to win the contract, they lowered the price.', kw: { purpose: 'win the contract', action: 'lowered the price' } },
    ],
    expectedMarkers: ['in order to'], expectedOrders: ['marker_first'],
    transfer: [
      { text: 'In order to catch the flight, he woke at four.', kw: { purpose: 'catch the flight', action: 'woke at four' } },
      { text: 'In order to save the species, the park banned hunting.', kw: { purpose: 'save the species', action: 'park banned hunting' } },
      { text: 'In order to finish early, she skipped the break.', kw: { purpose: 'finish early', action: 'skipped the break' } },
      { text: 'In order to impress the client, they rewrote the proposal.', kw: { purpose: 'impress the client', action: 'rewrote the proposal' } },
      { text: 'In order to stay warm, we built a fire.', kw: { purpose: 'stay warm', action: 'built a fire' } },
      { text: 'In order to learn Spanish, he moved to Madrid.', kw: { purpose: 'learn Spanish', action: 'moved to Madrid' } },
      { text: 'In order to cut costs, the factory automated the line.', kw: { purpose: 'cut costs', action: 'factory automated the line' } },
      { text: 'In order to protect the reef, divers removed the nets.', kw: { purpose: 'protect the reef', action: 'divers removed the nets' } },
      { text: 'In order to win votes, the candidate toured the state.', kw: { purpose: 'win votes', action: 'candidate toured the state' } },
      { text: 'In order to sleep better, she banned screens at night.', kw: { purpose: 'sleep better', action: 'banned screens at night' } },
    ],
    negatives: [
      'I like apples and oranges.',
      'In order to.',
      'In order to win.',
      'Order to win, they tried.',
      { text: 'Because of the storm, the match was postponed.', expect: 'cause' },
      { text: 'If the train is late, we will miss the connection.', expect: 'condition' },
    ],
  },
  {
    relation: 'purpose', familyId: 'to_mid', order: 'marker_mid',
    roleNames: ['action', 'purpose'],
    training: [
      { text: 'She studied late to pass the exam.', kw: { action: 'studied late', purpose: 'pass the exam' } },
      { text: 'They lowered the price to win the contract.', kw: { action: 'lowered the price', purpose: 'win the contract' } },
    ],
    expectedMarkers: ['to'], expectedOrders: ['marker_mid'],
    transfer: [
      { text: 'He woke at four to catch the flight.', kw: { action: 'woke at four', purpose: 'catch the flight' } },
      { text: 'The park banned hunting to save the species.', kw: { action: 'park banned hunting', purpose: 'save the species' } },
      { text: 'She skipped the break to finish early.', kw: { action: 'skipped the break', purpose: 'finish early' } },
      { text: 'They rewrote the proposal to impress the client.', kw: { action: 'rewrote the proposal', purpose: 'impress the client' } },
      { text: 'We built a fire to stay warm.', kw: { action: 'built a fire', purpose: 'stay warm' } },
      { text: 'He moved to Madrid to learn Spanish.', kw: { action: 'moved to Madrid', purpose: 'learn Spanish' } },
      { text: 'She shut off the water to fix the leak.', kw: { action: 'shut off the water', purpose: 'fix the leak' } },
      { text: 'He practiced daily to learn the song.', kw: { action: 'practiced daily', purpose: 'learn the song' } },
      { text: 'The climbers left at dawn to reach the summit.', kw: { action: 'climbers left at dawn', purpose: 'reach the summit' } },
      { text: 'The farmer built a fence to protect the crops.', kw: { action: 'farmer built a fence', purpose: 'protect the crops' } },
    ],
    negatives: [
      'I want to leave early.',
      'They need to finish soon.',
      'They donated money to the charity.',
      'I went to the store.',
      'She tried to understand.',
      'I like apples and oranges.',
    ],
  },
  {
    relation: 'purpose', familyId: 'in_order_to_mid', order: 'marker_mid',
    roleNames: ['action', 'purpose'],
    training: [
      { text: 'She studied late in order to pass the exam.', kw: { action: 'studied late', purpose: 'pass the exam' } },
      { text: 'They lowered the price in order to win the contract.', kw: { action: 'lowered the price', purpose: 'win the contract' } },
    ],
    expectedMarkers: ['in order to'], expectedOrders: ['marker_mid'],
    transfer: [
      { text: 'He woke at four in order to catch the flight.', kw: { action: 'woke at four', purpose: 'catch the flight' } },
      { text: 'The park banned hunting in order to save the species.', kw: { action: 'park banned hunting', purpose: 'save the species' } },
      { text: 'She skipped the break in order to finish early.', kw: { action: 'skipped the break', purpose: 'finish early' } },
      { text: 'They rewrote the proposal in order to impress the client.', kw: { action: 'rewrote the proposal', purpose: 'impress the client' } },
      { text: 'We built a fire in order to stay warm.', kw: { action: 'built a fire', purpose: 'stay warm' } },
      { text: 'He moved to Madrid in order to learn Spanish.', kw: { action: 'moved to Madrid', purpose: 'learn Spanish' } },
      { text: 'The factory automated the line in order to cut costs.', kw: { action: 'factory automated the line', purpose: 'cut costs' } },
      { text: 'Divers removed the nets in order to protect the reef.', kw: { action: 'divers removed the nets', purpose: 'protect the reef' } },
      { text: 'The candidate toured the state in order to win votes.', kw: { action: 'candidate toured the state', purpose: 'win votes' } },
      { text: 'She banned screens at night in order to sleep better.', kw: { action: 'banned screens at night', purpose: 'sleep better' } },
    ],
    negatives: [
      'I like apples and oranges.',
      'She studied in order to.',
      'In order to.',
      { text: 'The engine overheated because the coolant leaked.', expect: 'cause' },
      { text: 'The crops will fail unless it rains soon.', expect: 'condition' },
      'Because.',
    ],
  },
  {
    relation: 'purpose', familyId: 'so_that_mid', order: 'marker_mid',
    roleNames: ['action', 'purpose'],
    training: [
      { text: 'They left early so that they would arrive on time.', kw: { action: 'left early', purpose: 'would arrive on time' } },
      { text: 'She whispered so that the baby would not wake.', kw: { action: 'whispered', purpose: 'baby would not wake' } },
    ],
    expectedMarkers: ['so that'], expectedOrders: ['marker_mid'],
    transfer: [
      { text: 'He saved money so that he could buy the car.', kw: { action: 'saved money', purpose: 'could buy the car' } },
      { text: 'They spoke slowly so that everyone would understand.', kw: { action: 'spoke slowly', purpose: 'everyone would understand' } },
      { text: 'She locked the door so that the dog would stay inside.', kw: { action: 'locked the door', purpose: 'dog would stay inside' } },
      { text: 'We left a note so that the cleaner would know.', kw: { action: 'left a note', purpose: 'cleaner would know' } },
      { text: 'He wore a tie so that he would look professional.', kw: { action: 'wore a tie', purpose: 'would look professional' } },
      { text: 'They built a wall so that the noise would stay out.', kw: { action: 'built a wall', purpose: 'noise would stay out' } },
      { text: 'She set two alarms so that she would wake up.', kw: { action: 'set two alarms', purpose: 'would wake up' } },
      { text: 'He studied the map so that he would not get lost.', kw: { action: 'studied the map', purpose: 'would not get lost' } },
      { text: 'They hired a guide so that the trip would go smoothly.', kw: { action: 'hired a guide', purpose: 'trip would go smoothly' } },
      { text: 'She dimmed the lights so that the movie would feel cinematic.', kw: { action: 'dimmed the lights', purpose: 'movie would feel cinematic' } },
    ],
    negatives: [
      'I like apples and oranges.',
      'So that.',
      'They left early so that.',
      'So that they would arrive, they left.',
      { text: 'He was tired yet he kept going.', expect: 'contrast' },
      'Because.',
    ],
  },
  // ---- concession ----
  {
    relation: 'concession', familyId: 'despite_front', order: 'marker_first',
    roleNames: ['a', 'b'],
    training: [
      { text: 'Despite the rain, the game continued.', kw: { a: 'the rain', b: 'game continued' } },
      { text: 'In spite of the delay, the project finished on time.', kw: { a: 'the delay', b: 'project finished on time' } },
    ],
    expectedMarkers: ['despite', 'in spite of'], expectedOrders: ['marker_first'],
    transfer: [
      { text: 'Despite the cost, the board approved the plan.', kw: { a: 'the cost', b: 'board approved the plan' } },
      { text: 'In spite of the noise, the baby slept through.', kw: { a: 'the noise', b: 'baby slept through' } },
      { text: 'Despite the late hour, the negotiations continued.', kw: { a: 'the late hour', b: 'negotiations continued' } },
      { text: 'Despite his injury, the runner finished the race.', kw: { a: 'his injury', b: 'runner finished the race' } },
      { text: 'In spite of the heat, the workers kept their pace.', kw: { a: 'the heat', b: 'workers kept their pace' } },
      { text: 'Despite the warnings, the hikers took the shortcut.', kw: { a: 'the warnings', b: 'hikers took the shortcut' } },
      { text: 'In spite of the long lines, they stayed until the end.', kw: { a: 'the long lines', b: 'stayed until the end' } },
      { text: 'Despite the fog, the pilot landed safely.', kw: { a: 'the fog', b: 'pilot landed safely' } },
      { text: 'In spite of her fear, she spoke to the crowd.', kw: { a: 'her fear', b: 'spoke to the crowd' } },
      { text: 'Despite the mud, the trucks reached the site.', kw: { a: 'the mud', b: 'trucks reached the site' } },
    ],
    negatives: [
      'I like apples and oranges.',
      'Despite.',
      'Despite the rain',
      'The despite-clause needs a comma.',
      { text: 'Although the desert is hot, the nights are freezing.', expect: 'contrast' },
      'Because.',
    ],
  },
  {
    relation: 'concession', familyId: 'despite_mid', order: 'marker_mid',
    roleNames: ['a', 'b'],
    training: [
      { text: 'The game continued despite the rain.', kw: { a: 'the rain', b: 'game continued' } },
      { text: 'The project finished on time in spite of the delay.', kw: { a: 'the delay', b: 'project finished on time' } },
    ],
    expectedMarkers: ['despite', 'in spite of'], expectedOrders: ['marker_mid'],
    transfer: [
      { text: 'The board approved the plan despite the cost.', kw: { a: 'the cost', b: 'board approved the plan' } },
      { text: 'The baby slept through in spite of the noise.', kw: { a: 'the noise', b: 'baby slept through' } },
      { text: 'The runner finished the race despite his injury.', kw: { a: 'his injury', b: 'runner finished the race' } },
      { text: 'The workers kept their pace in spite of the heat.', kw: { a: 'the heat', b: 'workers kept their pace' } },
      { text: 'The hikers took the shortcut despite the warnings.', kw: { a: 'the warnings', b: 'hikers took the shortcut' } },
      { text: 'The pilot landed safely despite the fog.', kw: { a: 'the fog', b: 'pilot landed safely' } },
      { text: 'She spoke to the crowd in spite of her fear.', kw: { a: 'her fear', b: 'spoke to the crowd' } },
      { text: 'The trucks reached the site despite the mud.', kw: { a: 'the mud', b: 'trucks reached the site' } },
      { text: 'The garden survived despite the frost.', kw: { a: 'the frost', b: 'garden survived' } },
      { text: 'He smiled in spite of the pain.', kw: { a: 'the pain', b: 'smiled' } },
    ],
    negatives: [
      'I like apples and oranges.',
      'The game continued despite.',
      'Despite the rain.',
      { text: 'The engine is small but it pulls hard.', expect: 'contrast' },
      { text: 'The engine overheated because the coolant leaked.', expect: 'cause' },
      'Because.',
    ],
  },
];

// ---------------------------------------------------------------- helpers --
function freshModel(tag) {
  const dst = path.join(SCRATCH, `model-${tag}-${process.pid}-${Date.now()}.json`);
  const m = JSON.parse(fs.readFileSync(BASE_MODEL, 'utf8'));
  m.__lariSourcePath = dst;
  delete m[sem.SECTION]; // start clean: prove induction from zero
  fs.writeFileSync(dst, JSON.stringify(m));
  return JSON.parse(fs.readFileSync(dst, 'utf8'));
}

function rolesMatch(fired, roleNames, kw) {
  if (!fired || !fired.roles) return false;
  return roleNames.every(rn => {
    const span = String(fired.roles[rn] || '').toLowerCase();
    const want = String(kw[rn] || '').toLowerCase();
    return want && span.includes(want);
  });
}

function negText(n) { return typeof n === 'string' ? n : n.text; }
function negExpect(n) { return typeof n === 'string' ? null : (n.expect || null); }

function entriesFor(model, ct) {
  return ((model[sem.SECTION] || {}).entries || []).filter(e =>
    e && e.payload && e.payload.operatorAst &&
    e.payload.operatorAst.relation === ct.relation &&
    e.payload.operatorAst.signature === [ct.relation, ct.familyId, ct.order].join('::'));
}

const results = [];
function gate(construction, name, pass, detail) {
  results.push({ construction, gate: name, pass: pass === true, detail });
  const mark = pass === true ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}: ${detail}`);
}

// ------------------------------------------------------------------- run ---
async function main() {
  console.log('=== Small Lari native semantic-induction qualification (extended) ===');
  console.log(`scratch: ${SCRATCH}`);
  const inducedSoFar = []; // { relation, familyId, order, roleNames, transfer[] } for regression gate

  // One shared model across constructions: proves operators coexist.
  const model = freshModel('shared');

  for (const ct of CONSTRUCTION_TESTS) {
    const label = `${ct.relation}/${ct.familyId}`;
    console.log(`\n--- construction: ${label} ---`);

    // Gate 1: baseline — novelty. Either nothing parses, or the specific
    // relation does not fire (for narrower-than-broad constructions).
    let baseOk;
    if (ct.baselineAbsent) {
      baseOk = ct.training.every(t => {
        const f = sem.matchOperators(t.text, model);
        return !f || f.relation !== ct.relation;
      });
    } else {
      baseOk = ct.training.every(t => sem.matchOperators(t.text, model) === null);
    }
    gate(label, 'baseline (novelty)', baseOk,
      `${ct.training.filter(t => { const f = sem.matchOperators(t.text, model); return ct.baselineAbsent ? (!f || f.relation !== ct.relation) : f === null; }).length}/${ct.training.length} novel pre-induction`);

    // Gate 2: training — taught examples induce exactly one record for this family.
    let recordId = null;
    for (const t of ct.training) {
      const r = sem.noteCandidate(model, { text: t.text, source: 'teaching' });
      if (r.induced) recordId = r.recordId;
    }
    const entries = entriesFor(model, ct);
    const markersOk = entries.length === 1 &&
      JSON.stringify(entries[0].payload.operatorAst.markers) === JSON.stringify(ct.expectedMarkers);
    const ordersOk = entries.length === 1 &&
      JSON.stringify(entries[0].payload.operatorAst.surfaceOrders) === JSON.stringify(ct.expectedOrders);
    const trainingParses = ct.training.every(t => {
      const f = sem.matchOperators(t.text, model);
      return f && f.relation === ct.relation && rolesMatch(f, ct.roleNames, t.kw);
    });
    const inducedOk = entries.length === 1 && markersOk && ordersOk && trainingParses;
    gate(label, 'training (induction)', inducedOk,
      `records=${entries.length} markers=${JSON.stringify(entries[0] && entries[0].payload.operatorAst.markers)} orders=${JSON.stringify(entries[0] && entries[0].payload.operatorAst.surfaceOrders)} parses=${ct.training.filter(t => { const f = sem.matchOperators(t.text, model); return f && f.relation === ct.relation && rolesMatch(f, ct.roleNames, t.kw); }).length}/${ct.training.length}`);

    // Gate 3: hidden transfer — 10 unseen examples, new vocab/domains.
    let transferHits = 0;
    const transferMisses = [];
    for (const t of ct.transfer) {
      const f = sem.matchOperators(t.text, model);
      if (f && f.relation === ct.relation && rolesMatch(f, ct.roleNames, t.kw)) transferHits++;
      else transferMisses.push(`${t.text} [got ${f ? f.relation : 'null'}]`);
    }
    gate(label, 'hidden transfer', transferHits === ct.transfer.length,
      `${transferHits}/${ct.transfer.length}${transferMisses.length ? ' MISS: ' + transferMisses.join(' | ').slice(0, 220) : ''}`);

    // Gate 4: negative controls — refused, or parsed as the expected OTHER relation.
    let negOk = 0;
    const negBad = [];
    for (const n of ct.negatives) {
      const f = sem.matchOperators(negText(n), model);
      const exp = negExpect(n);
      const ok = exp === null ? f === null : (f && f.relation === exp);
      if (ok) negOk++;
      else negBad.push(`${negText(n)} [got ${f ? f.relation + '/' + f.marker : 'null'}, want ${exp || 'null'}]`);
    }
    gate(label, 'negative controls', negOk === ct.negatives.length,
      `${negOk}/${ct.negatives.length}${negBad.length ? ' BAD: ' + negBad.join(' | ').slice(0, 260) : ''}`);

    // Gate 5: cold reload — JSON round-trip through disk, still fires.
    const diskPath = model.__lariSourcePath;
    fs.writeFileSync(diskPath, JSON.stringify(model));
    const reloaded = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
    const reloadHits = ct.transfer.slice(0, 3).filter(t => {
      const f = sem.matchOperators(t.text, reloaded);
      return f && f.relation === ct.relation && rolesMatch(f, ct.roleNames, t.kw);
    }).length;
    gate(label, 'cold reload', reloadHits === 3, `${reloadHits}/3 transfer examples parse after disk round-trip`);

    // Gate 6: exact ablation — remove the record, the specific capability disappears.
    const ablated = JSON.parse(JSON.stringify(model));
    const sec = ablated[sem.SECTION];
    sec.entries = sec.entries.filter(e => e.id !== recordId);
    const ablatedGone = ct.training.every(t => {
      const f = sem.matchOperators(t.text, ablated);
      return !f || f.relation !== ct.relation;
    });
    const othersIntact = inducedSoFar.every(prev =>
      prev.transfer.slice(0, 2).every(t => {
        const f = sem.matchOperators(t.text, ablated);
        return f && f.relation === prev.relation;
      }));
    gate(label, 'exact ablation', ablatedGone && othersIntact,
      `capability gone=${ablatedGone} other operators intact=${othersIntact}`);

    // Gate 7: regression — all previously induced operators still pass.
    let regHits = 0, regTotal = 0;
    const regMiss = [];
    for (const prev of inducedSoFar) {
      for (const t of prev.transfer) {
        regTotal++;
        const f = sem.matchOperators(t.text, model);
        if (f && f.relation === prev.relation && rolesMatch(f, prev.roleNames, t.kw)) regHits++;
        else regMiss.push(`${prev.relation}/${prev.familyId}: ${t.text}`);
      }
    }
    gate(label, 'regression (prior operators)', regHits === regTotal,
      `${regHits}/${regTotal} prior transfer examples still parse${regMiss.length ? ' MISS: ' + regMiss.slice(0, 3).join(' | ') : ''}`);

    inducedSoFar.push({ relation: ct.relation, familyId: ct.familyId, roleNames: ct.roleNames, transfer: ct.transfer });
  }

  // ============================ STRESS SUITE ============================
  console.log('\n=== STRESS SUITE (noisy / nested / competing evidence) ===');
  const stressCases = [
    // multi-clause inputs
    { text: 'Because the dam cracked during the storm last night, the valley flooded by morning and the roads washed out.', expect: 'cause', kw: { cause: 'dam cracked', effect: 'valley flooded' } },
    // competing markers: outermost wins
    { text: 'Although it rained because the clouds gathered, the game continued.', expect: 'contrast', kw: { a: 'rained', b: 'game continued' } },
    { text: 'Because although it rained the game continued, we stayed.', expect: 'cause', kw: { cause: 'although it rained', effect: 'we stayed' } },
    { text: 'We stayed because although it rained the game continued.', expect: 'cause', kw: { cause: 'although it rained', effect: 'stayed' } },
    // nested same-relation: outermost wins
    { text: 'Because the dam cracked because the inspectors lied, the valley flooded.', expect: 'cause', kw: { cause: 'dam cracked', effect: 'valley flooded' } },
    // embedded (non-matrix) constructions refuse
    { text: 'He said that although it rained, they stayed.', expect: null },
    // double-to purpose (last-scan)
    { text: 'He moved to Madrid to learn Spanish.', expect: 'purpose', kw: { action: 'moved to Madrid', purpose: 'learn Spanish' } },
    // counterfactual beats plain conditional on the same surface
    { text: 'If he had left earlier, he would have arrived on time.', expect: 'counterfactual' },
    { text: 'If the train is late, we will miss the connection.', expect: 'condition' },
    // cross-relation sanity
    { text: 'Because of the storm, the match was postponed.', expect: 'cause' },
    { text: 'While I was sleeping, the phone rang.', expect: null },
    { text: 'As the sun set, the campers returned.', expect: null },
    { text: 'As he was tired, he slept.', expect: null },
  ];
  let stressOk = 0;
  const stressBad = [];
  for (const s of stressCases) {
    const f = sem.matchOperators(s.text, model);
    const relOk = s.expect === null ? f === null : (f && f.relation === s.expect);
    const kwOk = !s.kw || (f && rolesMatch(f, Object.keys(s.kw), s.kw));
    if (relOk && kwOk) stressOk++;
    else stressBad.push(`${s.text} [got ${f ? f.relation + '/' + f.marker + ' ' + JSON.stringify(f.roles) : 'null'}, want ${s.expect || 'null'}]`);
  }
  gate('stress', 'nested/competing/multi-clause', stressOk === stressCases.length,
    `${stressOk}/${stressCases.length}${stressBad.length ? ' BAD: ' + stressBad.join(' | ').slice(0, 300) : ''}`);

  // paraphrased teaching: varied surface forms still induce one coherent operator
  {
    const pm = freshModel('paraphrase');
    const r1 = sem.noteCandidate(pm, { text: 'Because the dam cracked, the valley flooded.', source: 'teaching' });
    const r2 = sem.noteCandidate(pm, { text: 'Since the storm hit hard, the roads washed out.', source: 'teaching' });
    const r3 = sem.noteCandidate(pm, { text: 'Because of the drought, the crops failed.', source: 'teaching' });
    const recs = ((pm[sem.SECTION] || {}).entries || []).filter(e => e && e.payload && e.payload.operatorAst && e.payload.operatorAst.relation === 'cause');
    // Third example is fully redundant (marker+order already represented):
    // honest 'already_represented' is correct, not a refinement claim.
    const ok = r2.induced === true && recs.length === 1 &&
      JSON.stringify(recs[0].payload.operatorAst.markers) === JSON.stringify(['because', 'since']) &&
      (r3.refined === true || r3.reason === 'operator_already_active');
    gate('stress', 'paraphrased teaching', ok,
      `induced=${r2.induced} records=${recs.length} markers=${JSON.stringify(recs[0] && recs[0].payload.operatorAst.markers)} third=${r3.refined ? 'refined' : r3.reason}`);
  }

  // ========================= ROBUSTNESS SUITE =========================
  console.log('\n=== ROBUSTNESS SUITE ===');

  // R1: conflicting evidence -> induction REFUSES, never a garbage operator.
  {
    const cm = freshModel('conflict');
    const sec = sem.ensureSection(cm);
    const bad = sem.induceOperator(sec, 'cause::because_front::marker_first', [
      { text: 'Because the dam cracked, the valley flooded.', marker: 'because', relation: 'cause', familyId: 'because_front', order: 'marker_first', source: 'teaching' },
      { text: 'Although it rained, we stayed inside.', marker: 'although', relation: 'contrast', familyId: 'concessive_front', order: 'marker_first', source: 'teaching' },
    ]);
    const noGarbage = (sec.entries || []).length === 0;
    gate('robust', 'R1 conflicting evidence refuses', bad.induced === false && noGarbage,
      `induced=${bad.induced} reason=${bad.reason} entries=${(sec.entries || []).length}`);
    // Interleaved teaching of two relations -> two clean operators, no garbage.
    const im = freshModel('interleave');
    sem.noteCandidate(im, { text: 'Because the dam cracked, the valley flooded.', source: 'teaching' });
    sem.noteCandidate(im, { text: 'Although it rained, we stayed inside.', source: 'teaching' });
    sem.noteCandidate(im, { text: 'Since the storm hit, the roads washed out.', source: 'teaching' });
    sem.noteCandidate(im, { text: 'Though it was late, they kept working.', source: 'teaching' });
    const rels = ((im[sem.SECTION] || {}).entries || []).map(e => e.payload.operatorAst.relation).sort();
    gate('robust', 'R1 interleaved teaching separates', JSON.stringify(rels) === JSON.stringify(['cause', 'contrast']),
      `relations=${JSON.stringify(rels)}`);
  }

  // R2: outlier rejection — 3 consistent + 1 contradictory.
  {
    const om = freshModel('outlier');
    sem.noteCandidate(om, { text: 'Because the dam cracked, the valley flooded.', source: 'teaching' });
    const sec = sem.ensureSection(om);
    const sig = Object.keys(sec.pending)[0];
    sec.pending[sig].push({ key: 'injected-outlier', text: 'Although it rained, we stayed inside.', marker: 'although', relation: 'contrast', familyId: 'concessive_front', order: 'marker_first', source: 'teaching' });
    const r = sem.noteCandidate(om, { text: 'Since the storm hit hard, the roads washed out.', source: 'teaching' });
    const q = sem.quarantinedList(om);
    const recs = (sec.entries || []).filter(e => e && e.payload && e.payload.operatorAst && e.payload.operatorAst.relation === 'cause');
    const ok = r.induced === true && recs.length === 1 &&
      JSON.stringify(recs[0].payload.operatorAst.markers) === JSON.stringify(['because', 'since']) &&
      q.length === 1 && q[0].reason === 'incoherent_minority';
    gate('robust', 'R2 outlier quarantined', ok,
      `induced=${r.induced} markers=${JSON.stringify(recs[0] && recs[0].payload.operatorAst.markers)} quarantined=${q.length} reason=${q[0] && q[0].reason}`);
  }

  // R3: surface noise suite — typos, caps, missing commas, extra whitespace.
  {
    const noise = [
      ['becuase the dam cracked, the valley flooded.', 'cause'],
      ['BECAUSE THE DAM CRACKED, THE VALLEY FLOODED.', 'cause'],
      ['Because   the dam cracked,   the valley flooded.', 'cause'],
      ['Because the dam cracked; the valley flooded.', 'cause'],
      ['Because the dam cracked the valley flooded.', 'cause'],
      ['althouhg the night was cold, the travelers pressed on.', 'contrast'],
      ['altho the night was cold, the travelers pressed on.', null],
      ['The engine overheated becuase the coolant leaked.', 'cause'],
      ['IF THE TRAIN IS LATE, WE WILL MISS THE CONNECTION.', 'condition'],
      ['   Because the dam cracked, the valley flooded.   ', 'cause'],
      ['The crops will fail unless it rains soon?!', 'condition'],
      ['He was tired YET he kept going.', 'contrast'],
      ['The crops will fail unless it rains soon', 'condition'],
      ['She studied late to pass the exam', 'purpose'],
    ];
    let hits = 0;
    const misses = [];
    for (const [text, want] of noise) {
      const f = sem.matchOperators(text, model);
      const ok = want === null ? f === null : (f && f.relation === want);
      if (ok) hits++;
      else misses.push(`${text} [got ${f ? f.relation : 'null'}]`);
    }
    gate('robust', 'R3 surface noise', hits === noise.length,
      `${hits}/${noise.length}${misses.length ? ' MISS: ' + misses.join(' | ').slice(0, 240) : ''}`);
  }

  // R5: marker collisions, both directions.
  {
    const coll = [
      ['Since the rains never came, the crops failed.', 'cause'],
      ['Since Tuesday, the store has been closed.', null],
      ["I've lived here since 2019.", null],
      ['The streets flooded since the river rose.', 'cause'],
      ['While the plan is risky, we should try it.', 'contrast'],
      ['While I was sleeping, the phone rang.', null],
      ['While they were eating, the power went out.', null],
      ['As the sun set, the campers returned.', null],
      ['As he was tired, he slept.', null],
      ['If you ask me, he is honest.', null],
      ["Since you're here, grab a seat.", null],
      ['To be honest, he is right.', null],
      ['I want to leave early.', null],
      ['They donated money to the charity.', null],
    ];
    let hits = 0;
    const misses = [];
    for (const [text, want] of coll) {
      const f = sem.matchOperators(text, model);
      const ok = want === null ? f === null : (f && f.relation === want);
      if (ok) hits++;
      else misses.push(`${text} [got ${f ? f.relation + '/' + f.marker : 'null'}, want ${want || 'null'}]`);
    }
    gate('robust', 'R5 marker collisions', hits === coll.length,
      `${hits}/${coll.length}${misses.length ? ' MISS: ' + misses.join(' | ').slice(0, 260) : ''}`);
  }

  // R6: state hardening.
  {
    // (a) corrupt operator records: never crash, never fire from garbage.
    const hm = freshModel('corrupt');
    const hsec = sem.ensureSection(hm);
    hsec.entries = [
      null,
      {},
      { status: 'active' },
      { status: 'active', payload: null },
      { status: 'active', payload: { operatorAst: { kind: 'wrong' } } },
      { status: 'active', confidence: 'high', payload: { operatorAst: { kind: 'lari.semantic_operator', relation: 'cause', markers: 'because', surfaceOrders: ['marker_first'], roles: ['cause', 'effect'] } } },
      { status: 'active', confidence: 0.9, payload: { operatorAst: { kind: 'lari.semantic_operator', relation: 'cause' } } },
      { status: 'active', confidence: 0.9, payload: { operatorAst: { kind: 'lari.semantic_operator', relation: 'nope', markers: ['because'], surfaceOrders: ['marker_first'], roles: ['x', 'y'] } } },
    ];
    let threw = false;
    let mres = 'unset';
    try {
      mres = sem.matchOperators('Because the dam cracked, the valley flooded.', hm);
      sem.noteCandidate(hm, { text: 'Because the dam cracked, the valley flooded.', source: 'teaching' });
      sem.noteTurn(hm, { userMessage: 'Because the dam cracked, the valley flooded.' });
    } catch (e) { threw = true; }
    gate('robust', 'R6a corrupt records inert', threw === false && mres === null,
      `threw=${threw} match=${mres === null ? 'null' : 'FIRED'}`);

    // (b) unknown future schema version: degrade to no-op with logged reason.
    const sm = freshModel('schemaver');
    const ssec = sem.ensureSection(sm);
    ssec.schemaVersion = 999;
    ssec.entries = [{ id: 'x', status: 'active' }];
    let threw2 = false;
    let nres, mres2;
    try {
      nres = sem.noteCandidate(sm, { text: 'Because the dam cracked, the valley flooded.', source: 'teaching' });
      mres2 = sem.matchOperators('Because the dam cracked, the valley flooded.', sm);
    } catch (e) { threw2 = true; }
    const notClobbered = ssec.entries.length === 1 && ssec.entries[0].id === 'x';
    gate('robust', 'R6b future schema degrades', threw2 === false && nres.reason === 'unsupported_schema_version' && mres2 === null && notClobbered,
      `threw=${threw2} reason=${nres.reason} match=${mres2 === null ? 'null' : 'FIRED'} entries_preserved=${notClobbered}`);

    // (c) pending-window overflow: 6 teachings same signature stay bounded.
    const pm = freshModel('overflow');
    const texts = [
      'Because the dam cracked, the valley flooded.',
      'Because the bridge fell, the town was isolated.',
      'Because the alarm rang, the guards responded.',
      'Because the chef quit, the menu changed.',
      'Because the storm hit, the match was postponed.',
      'Because the server died, the site went dark.',
    ];
    for (const t of texts) sem.noteCandidate(pm, { text: t, source: 'teaching' });
    const psec = sem.ensureSection(pm);
    const pendSizes = Object.values(psec.pending).map(a => a.length);
    const causeRecs = (psec.entries || []).filter(e => e && e.payload && e.payload.operatorAst && e.payload.operatorAst.relation === 'cause');
    gate('robust', 'R6c pending overflow bounded', Math.max(...pendSizes, 0) <= 4 && causeRecs.length === 1,
      `max_pending=${Math.max(...pendSizes, 0)} cause_records=${causeRecs.length}`);

    // mixed relations overflow: two teachings per relation, all four must
    // induce separately (unrelated singles would rightly stay pending).
    const mm = freshModel('overflow2');
    const mix = [
      'Because the dam cracked, the valley flooded.',
      'Since the storm hit, the roads washed out.',
      'Although it rained, we stayed inside.',
      'Though it was late, they kept working.',
      'If the train is late, we will miss the connection.',
      'If the dough rises, the bread will be fluffy.',
      'To win the game, they trained hard.',
      'To pass the exam, she studied every night.',
    ];
    for (const t of mix) sem.noteCandidate(mm, { text: t, source: 'teaching' });
    const mrels = ((mm[sem.SECTION] || {}).entries || []).map(e => e.payload.operatorAst.relation).sort();
    gate('robust', 'R6c mixed overflow separates', JSON.stringify(mrels) === JSON.stringify(['cause', 'condition', 'contrast', 'purpose']),
      `relations=${JSON.stringify(mrels)}`);

    // (d) light fuzz of the persistence layer: 60 random mutations, never throw.
    const fm = freshModel('fuzz');
    for (const t of CONSTRUCTION_TESTS[0].training) sem.noteCandidate(fm, { text: t.text, source: 'teaching' });
    let fuzzThrew = 0;
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const victims = [
      () => { const s = fm[sem.SECTION]; delete s.entries; },
      () => { const s = fm[sem.SECTION]; s.entries = null; },
      () => { const s = fm[sem.SECTION]; s.entries.push(null); },
      () => { const s = fm[sem.SECTION]; s.entries[0].payload = 'x'; },
      () => { const s = fm[sem.SECTION]; s.entries[0].confidence = 'high'; },
      () => { const s = fm[sem.SECTION]; s.stats = null; },
      () => { const s = fm[sem.SECTION]; s.pending = null; },
      () => { const s = fm[sem.SECTION]; s.quarantined = 'nope'; },
      () => { const s = fm[sem.SECTION]; delete s.schemaVersion; },
      () => { const s = fm[sem.SECTION]; s.entries[0].payload.operatorAst.markers = 'because'; },
    ];
    for (let i = 0; i < 60; i++) {
      const gm = JSON.parse(JSON.stringify(fm));
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) { try { victims[Math.floor(rnd() * victims.length)](); } catch (e) { /* mutator itself */ } }
      try {
        sem.ensureSection(gm);
        sem.matchOperators('Because the dam cracked, the valley flooded.', gm);
        sem.noteCandidate(gm, { text: 'Because the dam cracked, the valley flooded.', source: 'teaching' });
        sem.noteTurn(gm, { userMessage: 'Because the dam cracked, the valley flooded.' });
        sem.operatorCount(gm);
        sem.listOperators(gm);
      } catch (e) { fuzzThrew++; }
    }
    gate('robust', 'R6d fuzz never throws', fuzzThrew === 0, `${60 - fuzzThrew}/60 mutations clean`);
  }

  // R3-refinement (original task 3): re-teaching refines, never forks duplicates.
  {
    const rm = freshModel('refine');
    sem.noteCandidate(rm, { text: 'Because the dam cracked, the valley flooded.', source: 'teaching' });
    sem.noteCandidate(rm, { text: 'Because the bridge fell, the town was isolated.', source: 'teaching' });
    const c1 = ((rm[sem.SECTION] || {}).entries || []).length;
    sem.noteCandidate(rm, { text: 'Since the storm hit, the roads washed out.', source: 'teaching' });
    sem.noteCandidate(rm, { text: 'Since the rains failed, the crops died.', source: 'teaching' });
    const rsec = sem.ensureSection(rm);
    const causeRecs = (rsec.entries || []).filter(e => e && e.payload && e.payload.operatorAst && e.payload.operatorAst.relation === 'cause');
    const c2 = causeRecs.length;
    const markers2 = causeRecs[0] && causeRecs[0].payload.operatorAst.markers;
    sem.noteCandidate(rm, { text: 'The engine overheated because the coolant leaked.', source: 'teaching' });
    sem.noteCandidate(rm, { text: 'The streets flooded since the river rose.', source: 'teaching' });
    const c3 = (rsec.entries || []).length;
    sem.noteCandidate(rm, { text: 'The engine overheated because the coolant leaked.', source: 'teaching' });
    const c4 = (rsec.entries || []).length;
    gate('robust', 'R3 refine-not-fork', c1 === 1 && c2 === 1 && JSON.stringify(markers2) === JSON.stringify(['because', 'since']) && c3 === 2 && c4 === 2,
      `after_front=${c1} after_more_front=${c2} markers=${JSON.stringify(markers2)} after_mid=${c3} after_reteach_mid=${c4}`);
  }

  // R7: scale smoke — operator count, cross-talk matrix, timing.
  {
    const n = sem.operatorCount(model);
    gate('robust', 'R7a scale: 10+ operators', n >= 10, `${n} active operators`);
    const cross = [
      ['Because of the storm, the match was postponed.', 'cause'],
      ['If the train is late, we will miss the connection.', 'condition'],
      ['Since the rains never came, the crops failed.', 'cause'],
      ['Although the desert is hot, the nights are freezing.', 'contrast'],
      ['The engine is small but it pulls hard.', 'contrast'],
      ['To win the game, they trained hard.', 'purpose'],
      ['She studied late to pass the exam.', 'purpose'],
      ['Despite the rain, the game continued.', 'concession'],
      ['The game continued despite the rain.', 'concession'],
      ['If he had left earlier, he would have arrived on time.', 'counterfactual'],
      ['The crops will fail unless it rains soon.', 'condition'],
      ['While the plan is risky, we should try it.', 'contrast'],
    ];
    let chits = 0;
    const cbad = [];
    for (const [text, want] of cross) {
      const f = sem.matchOperators(text, model);
      if (f && f.relation === want) chits++;
      else cbad.push(`${text} [got ${f ? f.relation : 'null'}]`);
    }
    gate('robust', 'R7b cross-talk matrix', chits === cross.length,
      `${chits}/${cross.length}${cbad.length ? ' BAD: ' + cbad.join(' | ').slice(0, 200) : ''}`);
    gate('robust', 'R7c harness runtime sane', Date.now() - T0 < 300000, `${((Date.now() - T0) / 1000).toFixed(1)}s elapsed`);
  }

  // Determinism: same input twice -> byte-identical match output; same
  // examples on a fresh model -> identical record IDs.
  const detText = CONSTRUCTION_TESTS[0].transfer[0].text;
  const d1 = JSON.stringify(sem.matchOperators(detText, model));
  const d2 = JSON.stringify(sem.matchOperators(detText, model));
  // Same teachings on two independent fresh models -> identical record IDs.
  const m2 = freshModel('det');
  const m3 = freshModel('det2');
  for (const t of CONSTRUCTION_TESTS[0].training) {
    sem.noteCandidate(m2, { text: t.text, source: 'teaching' });
    sem.noteCandidate(m3, { text: t.text, source: 'teaching' });
  }
  const recIds = (m) => ((m[sem.SECTION] || {}).entries || []).map(e => e.id).sort().join(',');
  const id1 = recIds(m2);
  const id2 = recIds(m3);
  const detOk = d1 === d2 && id1 === id2 && d1.length > 0 && id1.length > 0;
  gate('all', 'determinism', detOk, `match identical=${d1 === d2} record IDs identical=${id1 === id2}`);

  // Live-turn demonstration (module-level, simulated chat turns).
  console.log('\n--- live-turn demonstration (simulated chat) ---');
  const demoModel = freshModel('demo');
  const transcript = [];
  const t1 = sem.noteTurn(demoModel, { userMessage: 'lari, learn this pattern: Because the dam cracked, the valley flooded.' });
  transcript.push(`greg: lari, learn this pattern: Because the dam cracked, the valley flooded.\n  -> taught=${t1.taught} pending=${t1.pendingCount} induced=${t1.induced}`);
  const t2 = sem.noteTurn(demoModel, { userMessage: 'lari, learn this pattern: Since the winds shifted, the fire spread east.' });
  transcript.push(`greg: lari, learn this pattern: Since the winds shifted, the fire spread east.\n  -> taught=${t2.taught} induced=${t2.induced} record=${t2.recordId}`);
  const t3 = sem.noteTurn(demoModel, { userMessage: 'Because the server overheated, the website went offline.' });
  const f3 = t3.fired;
  transcript.push(`greg: Because the server overheated, the website went offline.\n  -> operator fired: ${f3 ? `${f3.relation}(${JSON.stringify(f3.roles)}) [${f3.operatorId}]` : 'NONE'}`);
  console.log(transcript.join('\n'));
  const demoOk = t1.taught && !t1.induced && t2.induced && !!f3 && f3.relation === 'cause';
  gate('all', 'live-turn demo', demoOk, 'teach -> teach -> unseen-vocab fire');

  // Real runtime turn through the integrated hook (if runtime loads).
  console.log('\n--- live runtime turn (integrated hook) ---');
  let runtimeOk = false;
  try {
    const runtime = require(path.join(ROOT, 'swarm_model_runtime.js'));
    const rmodel = freshModel('runtime');
    const send = runtime.sendMessageToLariAsync;
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('turn timeout')), ms))]);
    const r1 = await withTimeout(send(rmodel, 'lari, learn this pattern: Because the dam cracked, the valley flooded.', {}), 45000);
    const r2 = await withTimeout(send(rmodel, 'lari, learn this pattern: Since the winds shifted, the fire spread east.', {}), 45000);
    const r3 = await withTimeout(send(rmodel, 'Because the server overheated, the website went offline.', {}), 45000);
    const fired = r3 && r3.semanticInduction && r3.semanticInduction.fired;
    console.log(`  turn1 semanticInduction: ${JSON.stringify(r1 && r1.semanticInduction)}`);
    console.log(`  turn2 semanticInduction: ${JSON.stringify(r2 && r2.semanticInduction)}`);
    console.log(`  turn3 fired: ${fired ? fired.relation + ' ' + JSON.stringify(fired.roles) : 'NONE'}`);
    runtimeOk = !!(r2 && r2.semanticInduction && r2.semanticInduction.induced) && !!fired && fired.relation === 'cause';
  } catch (e) {
    console.log(`  runtime turn failed: ${e && e.message}`);
  }
  gate('all', 'runtime hook integration', runtimeOk, runtimeOk ? 'hook recorded teaching, induced, and fired via real chat turns' : 'see error above');

  // Summary
  const failed = results.filter(r => !r.pass);
  console.log('\n=== SUMMARY ===');
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.construction}  ${r.gate}  ${r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} gates passed`);
  console.log(`total time: ${((Date.now() - T0) / 1000).toFixed(1)}s`);

  // Hashes
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  console.log('\n=== SHA-256 ===');
  console.log(`${sha(path.join(ROOT, 'scripts', 'lari_semantic_induction.js'))}  scripts/lari_semantic_induction.js`);
  console.log(`${sha(path.join(ROOT, 'scripts', 'test_semantic_induction.js'))}  scripts/test_semantic_induction.js`);
  try {
    console.log(`${sha(path.join(ROOT, 'swarm_model_runtime.js'))}  swarm_model_runtime.js (with hook)`);
  } catch (_) { /* ignore */ }

  if (failed.length) {
    console.log('\nVERDICT: NOT QUALIFIED — failed gates above.');
    process.exitCode = 1;
  } else {
    console.log('\nVERDICT: all gates passed.');
  }

  if (RUN_BATTERY) {
    console.log('\n=== chat battery (final regression) ===');
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('node', [path.join(ROOT, 'scripts', 'test_lari_chat_battery.js')], { cwd: ROOT, timeout: 600000 });
      console.log(out.toString().slice(-600));
    } catch (e) {
      console.log('battery run failed:', e && e.message);
      process.exitCode = 1;
    }
  }
}

main().catch(e => { console.error('HARNESS ERROR:', e && e.stack || e); process.exitCode = 2; });
