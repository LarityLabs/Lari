/**
 * user_manager.js — per-user Lari homes.
 *
 * Each Telegram user gets their own directory:
 *
 *   users/<telegramUserId>/
 *     profile.json    <- telegram id, username, first seen, lari display name
 *     model.json      <- THEIR Lari's brain (their learning only)
 *     workspace/      <- THEIR Lari's place to save shit it builds
 *
 * New users start from a deep copy of the shared base model (skills and all),
 * then diverge. model.json carries __lariSourcePath so the runtime's
 * auto-checkpoint persists learning straight to the user's file.
 *
 * Jailing: every file path a user's Lari touches is resolved under its own
 * workspace/. Anything escaping (.., absolute paths elsewhere) is refused.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function userDir(root, userId) {
  return path.join(root, 'users', String(userId));
}

function getOrCreateUserHome(root, tgUser) {
  const userId = String(tgUser.id);
  const dir = ensureDir(userDir(root, userId));
  const workspaceDir = ensureDir(path.join(dir, 'workspace'));
  const modelPath = path.join(dir, 'model.json');
  const profilePath = path.join(dir, 'profile.json');

  let profile = null;
  try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch (_) {}
  if (!profile) {
    profile = {
      telegramId: userId,
      username: tgUser.username || null,
      firstName: tgUser.first_name || null,
      lariName: `${tgUser.first_name || tgUser.username || 'friend'}'s Lari`,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  } else {
    profile.lastSeenAt = new Date().toISOString();
    profile.username = tgUser.username || profile.username;
    try { fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2)); } catch (_) {}
  }

  return { userId, dir, workspaceDir, modelPath, profilePath, profile };
}

/**
 * Load the user's model. First run: deep copy of the shared base model
 * (or a blank model), tagged with __lariSourcePath so the runtime
 * auto-checkpoint writes learning back to THIS user's file.
 */
function loadUserModel(home, baseModelPath) {
  let model = null;
  try { model = JSON.parse(fs.readFileSync(home.modelPath, 'utf8')); } catch (_) {}
  if (!model) {
    try { model = JSON.parse(fs.readFileSync(baseModelPath, 'utf8')); }
    catch (_) { model = {}; }
    // Deep copy so users never share object identity with the base.
    model = JSON.parse(JSON.stringify(model));
    model.__lariSourcePath = home.modelPath;
    model.__lariOwner = home.userId;
    atomicWrite(home.modelPath, model);
  } else if (!model.__lariSourcePath) {
    model.__lariSourcePath = home.modelPath;
  }
  return model;
}

function atomicWrite(filePath, obj) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, filePath);
}

function saveUserModel(home, model) {
  model.__lariSourcePath = home.modelPath;
  atomicWrite(home.modelPath, model);
}

function saveProfile(home) {
  try { fs.writeFileSync(home.profilePath, JSON.stringify(home.profile, null, 2)); } catch (_) {}
}

/**
 * Jail a requested path inside the user's workspace. Returns the absolute
 * path, or null if it escapes.
 */
function jailPath(workspaceDir, requested) {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, String(requested || ''));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function listUsers(root) {
  const usersRoot = path.join(root, 'users');
  let ids = [];
  try { ids = fs.readdirSync(usersRoot); } catch (_) {}
  return ids.filter(id => {
    try { return fs.statSync(path.join(usersRoot, id)).isDirectory(); } catch (_) { return false; }
  });
}

module.exports = {
  ensureDir,
  userDir,
  getOrCreateUserHome,
  loadUserModel,
  saveUserModel,
  saveProfile,
  jailPath,
  listUsers
};
