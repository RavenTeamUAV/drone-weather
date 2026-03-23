#!/usr/bin/env node
/**
 * Drone Weather — Admin CLI
 *
 * Usage:
 *   node admin.js list-users
 *   node admin.js reset-password <username> <newpassword>
 *   node admin.js delete-user <username>
 *   node admin.js gen-invite
 */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const isPkg  = typeof process.pkg !== 'undefined';
const dataDir = isPkg
  ? path.join(path.dirname(process.execPath), 'data')
  : path.join(__dirname, 'data');

const usersFile = path.join(dataDir, 'users.json');
const envFile   = path.join(__dirname, '.env');

function readUsers() {
  try { return JSON.parse(fs.readFileSync(usersFile, 'utf8')); }
  catch { return []; }
}

function writeUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), 'utf8');
}

const [,, cmd, ...args] = process.argv;

switch (cmd) {

  // ── list-users ────────────────────────────────────────────────────────────
  case 'list-users': {
    const users = readUsers();
    if (users.length === 0) { console.log('Немає зареєстрованих користувачів.'); break; }
    console.log(`\nКористувачі (${users.length}):\n`);
    users.forEach(u => {
      console.log(`  ${u.username.padEnd(20)} id: ${u.id}  створений: ${u.createdAt}`);
    });
    console.log('');
    break;
  }

  // ── reset-password ────────────────────────────────────────────────────────
  case 'reset-password': {
    const [username, newPassword] = args;
    if (!username || !newPassword) {
      console.error('Використання: node admin.js reset-password <username> <newpassword>');
      process.exit(1);
    }
    if (newPassword.length < 8) {
      console.error('Пароль мінімум 8 символів.');
      process.exit(1);
    }
    const users = readUsers();
    const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
    if (idx === -1) {
      console.error(`Користувача "${username}" не знайдено.`);
      process.exit(1);
    }
    users[idx].passwordHash = bcrypt.hashSync(newPassword, 12);
    writeUsers(users);
    console.log(`✓ Пароль для "${users[idx].username}" успішно змінено.`);
    break;
  }

  // ── delete-user ───────────────────────────────────────────────────────────
  case 'delete-user': {
    const [username] = args;
    if (!username) {
      console.error('Використання: node admin.js delete-user <username>');
      process.exit(1);
    }
    const users = readUsers();
    const filtered = users.filter(u => u.username.toLowerCase() !== username.toLowerCase());
    if (filtered.length === users.length) {
      console.error(`Користувача "${username}" не знайдено.`);
      process.exit(1);
    }
    writeUsers(filtered);
    console.log(`✓ Користувача "${username}" видалено.`);
    break;
  }

  // ── gen-invite ────────────────────────────────────────────────────────────
  case 'gen-invite': {
    const newCode = crypto.randomBytes(6).toString('hex'); // 12 символів hex
    let env = '';
    try { env = fs.readFileSync(envFile, 'utf8'); } catch {}

    if (/^INVITE_CODE=.*/m.test(env)) {
      env = env.replace(/^INVITE_CODE=.*/m, `INVITE_CODE=${newCode}`);
    } else {
      env = env.trimEnd() + `\nINVITE_CODE=${newCode}\n`;
    }
    fs.writeFileSync(envFile, env, 'utf8');
    console.log(`\n✓ Новий invite-код: ${newCode}\n`);
    console.log('  Поділіться ним з новим користувачем.');
    console.log('  Після реєстрації ви можете змінити код знову командою gen-invite.\n');
    break;
  }

  default: {
    console.log(`
Drone Weather — Admin CLI

Команди:
  node admin.js list-users                          — список всіх користувачів
  node admin.js reset-password <username> <пароль>  — скинути пароль
  node admin.js delete-user <username>              — видалити користувача
  node admin.js gen-invite                          — згенерувати новий invite-код
`);
  }
}
