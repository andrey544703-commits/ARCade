const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.disable('x-powered-by');
const port = process.env.PORT || 3000;
const storageRoot = process.env.STORAGE_DIR || __dirname;
const dataDir = path.join(storageRoot, 'data');
const uploadDir = path.join(storageRoot, 'uploads', 'games');
const coverDir = path.join(storageRoot, 'uploads', 'covers');
const gamesFile = path.join(dataDir, 'games.json');
const gamesBackupFile = path.join(dataDir, 'games.json.bak');
const moderatorsFile = path.join(dataDir, 'moderators.json');
const usersFile = path.join(dataDir, 'users.json');
const verificationCodes = new Map();
const sessions = new Map();

const mailer = process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    })
  : null;

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(coverDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(gamesFile)) fs.writeFileSync(gamesFile, '[]');
if (!fs.existsSync(moderatorsFile)) fs.writeFileSync(moderatorsFile, JSON.stringify([{ email: 'admin@arcade.local', nickname: 'moderator' }], null, 2));
if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, '[]');

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (request, file, callback) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    callback(null, `${Date.now()}-${safeName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});
const coverStorage = multer.diskStorage({
  destination: coverDir,
  filename: (request, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${extension}`);
  }
});
const uploadRelease = multer({
  storage: multer.diskStorage({
    destination: (request, file, callback) => callback(null, file.fieldname === 'coverImage' ? coverDir : uploadDir),
    filename: (request, file, callback) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      callback(null, `${Date.now()}-${safeName}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

function readGames() {
  try {
    return dedupeGames(JSON.parse(fs.readFileSync(gamesFile, 'utf8')));
  } catch (error) {
    console.error('games.json is corrupted, trying backup:', error.message);
    try {
      return JSON.parse(fs.readFileSync(gamesBackupFile, 'utf8'));
    } catch (backupError) {
      console.error('backup directory is unavailable:', backupError.message);
      return [];
    }
  }
}

function writeGames(games) {
  const unique = dedupeGames(games);
  const temporaryFile = `${gamesFile}.tmp`;
  if (fs.existsSync(gamesFile)) fs.copyFileSync(gamesFile, gamesBackupFile);
  fs.writeFileSync(temporaryFile, JSON.stringify(unique, null, 2));
  fs.renameSync(temporaryFile, gamesFile);
}

function dedupeGames(games) {
  const seen = new Set();
  return (Array.isArray(games) ? games : []).filter((game) => {
    if (!game || !game.id) return false;
    if (seen.has(game.id)) return false;
    seen.add(game.id);
    return true;
  });
}

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  } catch (error) {
    return [];
  }
}

function writeUsers(users) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const [salt, expected] = String(storedHash).split(':');
  if (!salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function publicUser(user) {
  if (!user) return null;
  return { email: user.email, nickname: user.nickname, role: user.role };
}

function parseCookies(request) {
  return Object.fromEntries((request.get('cookie') || '').split(';').filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    try {
      return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    } catch (error) {
      return ['', ''];
    }
  }));
}

function currentUser(request) {
  const token = parseCookies(request).arcade_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return readUsers().find((user) => user.email === session.email) || null;
}

function setSession(response, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { email: user.email, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `arcade_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=604800`);
}

function clearSession(request, response) {
  const token = parseCookies(request).arcade_session;
  if (token) sessions.delete(token);
  response.setHeader('Set-Cookie', 'arcade_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function isModerator(request) {
  const user = request.user || currentUser(request);
  if (!user) return false;
  try {
    return JSON.parse(fs.readFileSync(moderatorsFile, 'utf8')).some((moderator) => moderator.email.toLowerCase() === user.email.toLowerCase());
  } catch (error) {
    return false;
  }
}

function requireModerator(request, response, next) {
  request.user = request.user || currentUser(request);
  if (!isModerator(request)) return response.status(403).json({ message: 'Moderator rights are required.' });
  next();
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(__dirname));
app.use(express.json());

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const codeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 3, standardHeaders: true, legacyHeaders: false });

app.use((request, response, next) => {
  request.user = currentUser(request);
  next();
});

app.post('/api/auth/register', authLimiter, (request, response) => {
  const email = String(request.body?.email || '').trim().toLowerCase();
  const password = String(request.body?.password || '');
  const nickname = String(request.body?.nickname || '').trim();
  const role = request.body?.role === 'developer' ? 'developer' : 'user';
  const code = String(request.body?.code || '').trim();
  const pending = verificationCodes.get(email);
  if (!pending || pending.expiresAt < Date.now() || pending.code !== code) return response.status(400).json({ message: 'The verification code is invalid or expired.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ message: 'Enter a valid email address.' });
  if (password.length < 8) return response.status(400).json({ message: 'Password must be at least 8 characters.' });
  if (!nickname || nickname.length > 40) return response.status(400).json({ message: 'Choose a nickname up to 40 characters.' });
  const users = readUsers();
  if (users.some((user) => user.email === email)) return response.status(409).json({ message: 'This email already has an account.' });
  const user = { email, nickname, role, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
  users.push(user);
  writeUsers(users);
  verificationCodes.delete(email);
  setSession(response, user);
  response.status(201).json({ user: publicUser(user) });
});

app.post('/api/auth/login', authLimiter, (request, response) => {
  const email = String(request.body?.email || '').trim().toLowerCase();
  const password = String(request.body?.password || '');
  const user = readUsers().find((item) => item.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) return response.status(401).json({ message: 'Incorrect email or password.' });
  setSession(response, user);
  response.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (request, response) => {
  clearSession(request, response);
  response.json({ ok: true });
});

app.post('/api/auth/send-code', codeLimiter, async (request, response) => {
  const email = String(request.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response.status(400).json({ message: 'Enter a valid email address.' });
  }
  if (!mailer) {
    return response.status(503).json({ message: 'Email delivery is not configured on the server.' });
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  verificationCodes.set(email, { code, expiresAt: Date.now() + 10 * 60 * 1000 });
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Your ARCade verification code',
      text: `Your ARCade verification code is ${code}. It expires in 10 minutes.`
    });
    response.json({ message: 'Verification code sent.' });
  } catch (error) {
    verificationCodes.delete(email);
    console.error('Could not send verification email:', error.message);
    response.status(502).json({ message: 'Could not send the verification email.' });
  }
});

app.post('/api/auth/verify-code', (request, response) => {
  const email = String(request.body?.email || '').trim().toLowerCase();
  const code = String(request.body?.code || '').trim();
  const pending = verificationCodes.get(email);
  if (!pending || pending.expiresAt < Date.now() || pending.code !== code) {
    return response.status(400).json({ message: 'The verification code is invalid or expired.' });
  }
  verificationCodes.delete(email);
  response.json({ verified: true });
});

app.get('/api/session', (request, response) => {
  response.json({ user: publicUser(request.user), moderator: isModerator(request) });
});

app.get('/api/games', (request, response) => {
  response.json(readGames().filter((game) => (game.status || 'approved') === 'approved').map(normalizeGame));
});

app.get('/api/my-games', requireLogin, (request, response) => {
  const email = request.user.email;
  response.json(readGames().filter((game) => game.developerEmail === email).map(normalizeGame));
});

app.get('/api/moderation/games', requireModerator, (request, response) => {
  response.json(readGames().map(normalizeGame));
});

app.get('/api/moderation/moderators', requireModerator, (request, response) => {
  const moderators = JSON.parse(fs.readFileSync(moderatorsFile, 'utf8'));
  response.json(moderators);
});

app.post('/api/moderation/moderators', requireModerator, (request, response) => {
  const { email, nickname } = request.body || {};
  const trimmedEmail = String(email || '').trim().toLowerCase();
  const trimmedNickname = String(nickname || '').trim();

  if (!trimmedEmail || !trimmedNickname) {
    return response.status(400).json({ message: 'Email and nickname are required.' });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
    return response.status(400).json({ message: 'Enter a valid email address.' });
  }

  const moderators = JSON.parse(fs.readFileSync(moderatorsFile, 'utf8'));
  if (moderators.some((moderator) => moderator.email.toLowerCase() === trimmedEmail)) {
    return response.status(409).json({ message: 'This moderator already exists.' });
  }

  const moderator = { email: trimmedEmail, nickname: trimmedNickname };
  moderators.push(moderator);
  fs.writeFileSync(moderatorsFile, JSON.stringify(moderators, null, 2));
  response.status(201).json(moderator);
});

function normalizeGame(game) {
  const { reactions, reviews, developerEmail, ...publicGame } = game;
  return {
    ...publicGame,
    likes: game.likes || 0,
    dislikes: game.dislikes || 0,
    downloads: game.downloads || 0,
    reviews: [],
    reactionCount: Object.keys(reactions || {}).length
  };
}

app.get('/api/games/:id', (request, response) => {
  const email = request.user?.email;
  const game = readGames().filter((item) => (item.status || 'approved') === 'approved').map((item) => publicGame(item, email)).find((item) => item.id === request.params.id);
  if (!game) return response.status(404).json({ message: 'Game not found.' });
  response.json(game);
});

function publicGame(game, email) {
  const normalized = normalizeGame(game);
  const reactions = game.reactions || {};
  return {
    ...normalized,
    reaction: email ? reactions[email] || null : null,
    reviews: (game.reviews || []).map((review) => {
      const { email: reviewEmail, ...publicReview } = review;
      return { ...publicReview, reaction: reactions[reviewEmail] || null, isOwner: Boolean(email && reviewEmail === email) };
    })
  };
}

app.post('/api/games', requireLogin, uploadRelease.fields([{ name: 'gameFile', maxCount: 1 }, { name: 'coverImage', maxCount: 1 }]), (request, response) => {
  const gameFile = request.files?.gameFile?.[0];
  const coverImage = request.files?.coverImage?.[0];
  if (!gameFile) return response.status(400).json({ message: 'Please attach a game file.' });

  const { title, description, genre, color } = request.body;
  if (!request.user.email || !request.user.nickname) {
    fs.unlinkSync(gameFile.path);
    if (coverImage) fs.unlinkSync(coverImage.path);
    return response.status(403).json({ message: 'Developer account is not confirmed.' });
  }
  if (!title || !description || !developer) {
    fs.unlinkSync(gameFile.path);
    if (coverImage) fs.unlinkSync(coverImage.path);
    return response.status(400).json({ message: 'Please fill in the title, description, and developer.' });
  }

  const game = {
    id: `game-${Date.now()}`,
    title: title.trim(),
    description: description.trim(),
    genre: genre || 'Adventure',
    color: color || '#dcff36',
    featured: false,
    isNew: true,
    developer: request.user.nickname,
    developerEmail: request.user.email,
    status: 'pending',
    fileName: gameFile.originalname,
    fileUrl: `/downloads/${encodeURIComponent(gameFile.filename)}`,
    coverUrl: coverImage ? `/covers/${encodeURIComponent(coverImage.filename)}` : '',
    createdAt: new Date().toISOString(),
    likes: 0,
    dislikes: 0,
    downloads: 0,
    reviews: [],
    reactions: {}
  };

  const games = readGames();
  games.unshift(game);
  writeGames(games);
  response.status(201).json(game);
});

app.use('/downloads', express.static(uploadDir));
app.use('/covers', express.static(coverDir));

function requireLogin(request, response, next) {
  request.user = request.user || currentUser(request);
  if (!request.user) return response.status(401).json({ message: 'Please sign in to continue.' });
  next();
}

app.get('/api/games/:id/download', requireLogin, (request, response) => {
  const games = readGames();
  const game = games.find((item) => item.id === request.params.id);
  if (!game || (game.status || 'approved') !== 'approved') return response.status(404).json({ message: 'Game not found.' });
  game.downloads = (game.downloads || 0) + 1;
  writeGames(games);
  response.download(path.join(uploadDir, path.basename(decodeURIComponent(game.fileUrl.split('/').pop()))), game.fileName);
});

app.post('/api/games/:id/reviews', requireLogin, (request, response) => {
  const { text } = request.body;
  const email = request.user.email;
  if (!text?.trim()) return response.status(400).json({ message: 'Please write a review.' });
  const games = readGames();
  const game = games.find((item) => item.id === request.params.id);
  if (!game) return response.status(404).json({ message: 'Game not found.' });
  game.reviews = game.reviews || [];
  if (game.reviews.some((review) => review.email === email)) return response.status(409).json({ message: 'You already have a review. Edit it instead.' });
  game.reviews.unshift({ id: `review-${Date.now()}`, email, nickname: request.user.nickname, text: text.trim(), createdAt: new Date().toISOString() });
  writeGames(games);
  const { email: reviewEmail, ...createdReview } = game.reviews[0];
  response.status(201).json({ ...createdReview, reaction: (game.reactions || {})[email] || null, isOwner: true });
});

app.put('/api/games/:id/reviews/:reviewId', requireLogin, (request, response) => {
  const { text } = request.body;
  const email = request.user.email;
  if (!text?.trim()) return response.status(400).json({ message: 'Please write a review.' });
  const games = readGames();
  const game = games.find((item) => item.id === request.params.id);
  const review = game?.reviews?.find((item) => item.id === request.params.reviewId);
  if (!game || !review) return response.status(404).json({ message: 'Review not found.' });
  if (review.email !== email && !isModerator(request)) return response.status(403).json({ message: 'Only your own review can be edited.' });
  review.text = text.trim();
  review.updatedAt = new Date().toISOString();
  writeGames(games);
  const { email: reviewEmail, ...updatedReview } = review;
  response.json({ ...updatedReview, reaction: (game.reactions || {})[email] || null, isOwner: true });
});

app.post('/api/games/:id/reaction', requireLogin, (request, response) => {
  const { type } = request.body;
  if (!['like', 'dislike'].includes(type)) return response.status(400).json({ message: 'Unknown reaction.' });
  const email = request.user.email;
  const games = readGames();
  const game = games.find((item) => item.id === request.params.id);
  if (!game) return response.status(404).json({ message: 'Game not found.' });
  game.likes = game.likes || 0;
  game.dislikes = game.dislikes || 0;
  game.reactions = game.reactions || {};
  const previousType = game.reactions[email];
  if (previousType === type) return response.json({ likes: game.likes, dislikes: game.dislikes, reaction: previousType });
  if (previousType) game[previousType === 'like' ? 'likes' : 'dislikes'] = Math.max(0, game[previousType === 'like' ? 'likes' : 'dislikes'] - 1);
  game[type === 'like' ? 'likes' : 'dislikes'] += 1;
  game.reactions[email] = type;
  writeGames(games);
  response.json({ likes: game.likes, dislikes: game.dislikes, reaction: type });
});

app.listen(port, () => {
  console.log(`ARCade running: http://localhost:${port}`);
});

app.delete('/api/games/:id/reviews/:reviewId', requireLogin, (request, response) => {
  const email = request.user.email;
  const games = readGames();
  const game = games.find((item) => item.id === request.params.id);
  const review = game?.reviews?.find((item) => item.id === request.params.reviewId);
  if (!game || !review) return response.status(404).json({ message: 'Review not found.' });
  if (review.email !== email && !isModerator(request)) return response.status(403).json({ message: 'Only your own review can be deleted.' });
  game.reviews = game.reviews.filter((item) => item.id !== request.params.reviewId);
  writeGames(games);
  response.json({ ok: true });
});

app.patch('/api/moderation/games/:id/status', requireModerator, (request, response) => {
  const { status } = request.body;
  if (!['approved', 'rejected'].includes(status)) return response.status(400).json({ message: 'Unknown status.' });
  const games = readGames();
  const game = games.find((item) => item.id === request.params.id);
  if (!game) return response.status(404).json({ message: 'Game not found.' });
  game.status = status;
  game.moderatedAt = new Date().toISOString();
  writeGames(games);
  response.json(normalizeGame(game));
});

app.put('/api/moderation/games/:id', requireModerator, (request, response) => {
  const { title, description, genre, color } = request.body;
  const games = readGames();
  const game = games.find((item) => item.id === request.params.id);
  if (!game) return response.status(404).json({ message: 'Game not found.' });
  if (title?.trim()) game.title = title.trim();
  if (description?.trim()) game.description = description.trim();
  if (genre) game.genre = genre;
  if (color) game.color = color;
  writeGames(games);
  response.json(normalizeGame(game));
});

app.delete('/api/moderation/games/:id', requireModerator, (request, response) => {
  const games = readGames();
  const game = games.find((item) => item.id === request.params.id);
  if (!game) return response.status(404).json({ message: 'Game not found.' });
  const fileName = game.fileUrl && path.basename(decodeURIComponent(game.fileUrl.split('/').pop()));
  const coverName = game.coverUrl && path.basename(decodeURIComponent(game.coverUrl.split('/').pop()));
  if (fileName) fs.rmSync(path.join(uploadDir, fileName), { force: true });
  if (coverName) fs.rmSync(path.join(coverDir, coverName), { force: true });
  writeGames(games.filter((item) => item.id !== request.params.id));
  response.json({ ok: true });
});