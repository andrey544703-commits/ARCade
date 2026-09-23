const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;
const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(__dirname, 'uploads', 'games');
const coverDir = path.join(__dirname, 'uploads', 'covers');
const gamesFile = path.join(dataDir, 'games.json');
const gamesBackupFile = path.join(dataDir, 'games.json.bak');
const moderatorsFile = path.join(dataDir, 'moderators.json');

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(coverDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(gamesFile)) fs.writeFileSync(gamesFile, '[]');
if (!fs.existsSync(moderatorsFile)) fs.writeFileSync(moderatorsFile, JSON.stringify([{ email: 'admin@arcade.local', nickname: 'moderator' }], null, 2));

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

function isModerator(request) {
  const email = request.get('x-user-email');
  if (!email) return false;
  try {
    return JSON.parse(fs.readFileSync(moderatorsFile, 'utf8')).some((moderator) => moderator.email.toLowerCase() === email.toLowerCase());
  } catch (error) {
    return false;
  }
}

function requireModerator(request, response, next) {
  if (!isModerator(request)) return response.status(403).json({ message: 'Moderator rights are required.' });
  next();
}

app.use(express.static(__dirname));
app.use(express.json());

app.get('/api/session', requireLogin, (request, response) => {
  response.json({ moderator: isModerator(request) });
});

app.get('/api/games', (request, response) => {
  response.json(readGames().filter((game) => (game.status || 'approved') === 'approved').map(normalizeGame));
});

app.get('/api/my-games', requireLogin, (request, response) => {
  const email = request.get('x-user-email');
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
  const email = request.get('x-user-email');
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

  const { title, description, genre, color, developer, developerEmail } = request.body;
  if (developerEmail !== request.get('x-user-email')) {
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
    developer: developer.trim(),
    developerEmail: developerEmail || '',
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
  if (!request.get('x-user-email')) return response.status(401).json({ message: 'Please sign in to continue.' });
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
  const { text, nickname } = request.body;
  const email = request.get('x-user-email');
  if (!text?.trim() || !nickname?.trim()) return response.status(400).json({ message: 'Please write a review.' });
  const games = readGames();
  const game = games.find((item) => item.id === request.params.id);
  if (!game) return response.status(404).json({ message: 'Game not found.' });
  game.reviews = game.reviews || [];
  if (game.reviews.some((review) => review.email === email)) return response.status(409).json({ message: 'You already have a review. Edit it instead.' });
  game.reviews.unshift({ id: `review-${Date.now()}`, email, nickname: nickname.trim(), text: text.trim(), createdAt: new Date().toISOString() });
  writeGames(games);
  const { email: reviewEmail, ...createdReview } = game.reviews[0];
  response.status(201).json({ ...createdReview, reaction: (game.reactions || {})[email] || null, isOwner: true });
});

app.put('/api/games/:id/reviews/:reviewId', requireLogin, (request, response) => {
  const { text } = request.body;
  const email = request.get('x-user-email');
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
  const email = request.get('x-user-email');
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
  const email = request.get('x-user-email');
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