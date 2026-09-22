const state = {
  games: [],
  users: JSON.parse(localStorage.getItem('arcade_users') || '[]'),
  currentUser: JSON.parse(localStorage.getItem('arcade_current_user') || 'null'),
  saved: JSON.parse(localStorage.getItem('arcade_saved') || '[]'),
  filter: 'all',
  authMode: 'login'
};
state.users = state.users.map((user) => ({ ...user, role: user.role === 'developer' ? 'developer' : 'user' }));
if (state.currentUser) state.currentUser.role = state.currentUser.role === 'developer' ? 'developer' : 'user';
localStorage.setItem('arcade_users', JSON.stringify(state.users));
localStorage.setItem('arcade_current_user', JSON.stringify(state.currentUser));

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const persist = () => {
  localStorage.setItem('arcade_users', JSON.stringify(state.users));
  localStorage.setItem('arcade_saved', JSON.stringify(state.saved));
  localStorage.setItem('arcade_current_user', JSON.stringify(state.currentUser));
};
const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char]));
const initials = (name) => (name || '?').slice(0, 2).toUpperCase();
const isRecentRelease = (game) => game.createdAt && Date.now() - new Date(game.createdAt).getTime() <= 30 * 24 * 60 * 60 * 1000;
const currentHeaders = () => state.currentUser ? { 'x-user-email': state.currentUser.email } : {};
function syncCurrentUserPermissions() {
  if (!state.currentUser) return Promise.resolve();
  return fetch('/api/session', { headers: currentHeaders() }).then((response) => response.json()).then((permissions) => {
    state.currentUser.role = permissions.moderator ? 'moderator' : (state.currentUser.role === 'developer' ? 'developer' : 'user');
    const storedUser = state.users.find((user) => user.email === state.currentUser.email);
    if (storedUser) storedUser.role = state.currentUser.role;
    persist();
    updateProfile();
  }).catch(() => {});
}

function renderGameCard(game) {
  const isSaved = state.saved.includes(game.id);
  const cover = game.coverUrl ? `background-image:url('${escapeHtml(game.coverUrl)}');background-color:${escapeHtml(game.color)}` : `background:${escapeHtml(game.color)}`;
  return `<article class="game-card" data-game="${escapeHtml(game.id)}"><div class="game-cover" style="${cover}">${game.coverUrl ? '<span class="cover-image-overlay"></span>' : ''}<div class="game-meta"><span>${escapeHtml(game.genre)}</span><span>${isRecentRelease(game) ? 'new' : 'arcade'}</span></div><div class="cover-title">${escapeHtml(game.title).replace(' ', '<br>')}</div><div class="cover-shape"></div></div><div class="game-info"><div><h3>${escapeHtml(game.title)}</h3><p>${escapeHtml(game.developer)} · ${escapeHtml(game.description)}</p></div><div class="card-actions"><button class="small-button ${isSaved ? 'saved' : ''}" data-save="${escapeHtml(game.id)}" title="${isSaved ? 'Убрать из библиотеки' : 'Сохранить в библиотеку'}">${isSaved ? '✓' : '+'}</button><button class="small-button" data-download="${escapeHtml(game.id)}" title="Скачать игру">↓</button></div></div></article>`;
}

function bindGameActions(container) {
  $$(`${container} [data-save]`).forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); toggleSaved(button.dataset.save); }));
  $$(`${container} [data-download]`).forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); downloadGame(button.dataset.download); }));
  $$(`${container} [data-game]`).forEach((card) => card.addEventListener('click', () => openGame(card.dataset.game)));
}

function renderCatalog() {
  const games = state.games.filter((game) => (game.status || 'approved') === 'approved' && (state.filter === 'all' || (state.filter === 'featured' && game.featured) || (state.filter === 'new' && isRecentRelease(game))));
  $('#gamesGrid').innerHTML = games.map(renderGameCard).join('');
  $('#emptyState').classList.toggle('is-hidden', games.length > 0);
  bindGameActions('#gamesGrid');
}
function renderLibrary() {
  const games = state.games.filter((game) => state.saved.includes(game.id));
  $('#libraryGrid').innerHTML = games.map(renderGameCard).join('');
  $('#libraryEmpty').classList.toggle('is-hidden', games.length > 0);
  bindGameActions('#libraryGrid');
}
function renderStudio() {
  const ownGames = state.games.filter((game) => state.currentUser && game.developer === state.currentUser.nickname);
  renderStudioCards(ownGames);
  if (state.currentUser?.role === 'developer' || state.currentUser?.role === 'moderator') fetch('/api/my-games', { headers: currentHeaders() }).then((response) => response.json()).then((games) => { state.games = [...state.games.filter((game) => game.developerEmail !== state.currentUser.email), ...games]; renderStudioCards(games); }).catch(() => {});
}
function renderStudioCards(games) { $('#studioGames').innerHTML = games.length ? games.map((game) => `<div class="studio-game"><h4>${escapeHtml(game.title)}</h4><p>${escapeHtml(game.genre)} · ${escapeHtml(game.fileName)}</p><span class="release-status ${escapeHtml(game.status || 'approved')}">${game.status === 'pending' ? 'На проверке' : game.status === 'rejected' ? 'Отклонена' : 'Одобрена'}</span>${game.status === 'approved' ? `<a href="${escapeHtml(game.fileUrl)}" download>Скачать файл ↘</a>` : ''}</div>`).join('') : '<div class="studio-game"><h4>Пока нет релизов</h4><p>Первая публикация появится после отправки.</p></div>'; }
function renderModeration(games) {
  $('#moderationList').innerHTML = games.length ? games.map((game) => `<article class="moderation-item"><div><p class="eyebrow">${escapeHtml(game.status || 'approved')} / ${escapeHtml(game.developer)}</p><h3>${escapeHtml(game.title)}</h3><p>${escapeHtml(game.description)}</p></div><div class="moderation-actions"><button class="small-button" data-approve="${escapeHtml(game.id)}" title="Одобрить">✓</button><button class="small-button" data-reject="${escapeHtml(game.id)}" title="Отклонить">×</button><button class="small-button" data-edit-game="${escapeHtml(game.id)}" title="Редактировать">✎</button><button class="small-button" data-delete-game="${escapeHtml(game.id)}" title="Удалить">⌫</button></div></article>`).join('') : '<div class="empty-state"><span>✓</span><h3>Очередь пуста</h3><p>Новых публикаций на проверке нет.</p></div>';
  $$('[data-approve]').forEach((button) => button.addEventListener('click', () => moderateGame(button.dataset.approve, 'approved')));
  $$('[data-reject]').forEach((button) => button.addEventListener('click', () => moderateGame(button.dataset.reject, 'rejected')));
  $$('[data-edit-game]').forEach((button) => button.addEventListener('click', () => editModeratedGame(button.dataset.editGame)));
  $$('[data-delete-game]').forEach((button) => button.addEventListener('click', () => deleteModeratedGame(button.dataset.deleteGame)));
}
function loadModeration() { fetch('/api/moderation/games', { headers: currentHeaders() }).then((response) => response.json()).then((games) => { if (Array.isArray(games)) renderModeration(games); }).catch(() => toast('Не удалось загрузить очередь модерации.')); }
function moderateGame(id, status) { fetch(`/api/moderation/games/${encodeURIComponent(id)}/status`, { method: 'PATCH', headers: { ...currentHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }).then(async (response) => { if (!response.ok) throw new Error((await response.json()).message); loadModeration(); toast(status === 'approved' ? 'Игра одобрена' : 'Игра отклонена'); }).catch((error) => toast(error.message)); }
function editModeratedGame(id) { const game = state.games.find((item) => item.id === id); if (!game) return; const title = prompt('Название игры', game.title); const description = prompt('Описание игры', game.description); const genre = prompt('Жанр', game.genre); const color = prompt('Цвет обложки в формате #RRGGBB', game.color); if ([title, description, genre, color].some((value) => value === null)) return; fetch(`/api/moderation/games/${encodeURIComponent(id)}`, { method: 'PUT', headers: { ...currentHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ title, description, genre, color }) }).then(() => { loadModeration(); toast('Игра обновлена'); }); }
function deleteModeratedGame(id) { if (!confirm('Удалить игру и ее файлы?')) return; fetch(`/api/moderation/games/${encodeURIComponent(id)}`, { method: 'DELETE', headers: currentHeaders() }).then(() => { state.games = state.games.filter((game) => game.id !== id); renderCatalog(); loadModeration(); toast('Игра удалена'); }); }
function updateProfile() {
  const user = state.currentUser;
  $('#profileName').textContent = user ? user.nickname : 'Войти';
  $('#avatar').textContent = user ? initials(user.nickname) : '?';
  $('#menuUserName').textContent = user ? user.nickname : 'Гость';
  $('#menuUserEmail').textContent = user ? `${user.email} · ${user.role}` : 'Войдите, чтобы сохранять игры';
  $('#logoutButton').classList.toggle('is-hidden', !user);
  $('.developer-only').classList.toggle('is-hidden', !user || !['developer', 'moderator'].includes(user.role));
  $('.moderator-only').classList.toggle('is-hidden', !user || user.role !== 'moderator');
  renderStudio();
  if (user?.role === 'moderator') loadModeration();
}
function toggleSaved(id) {
  if (!state.currentUser) { openModal('authModal'); showAuthMessage('Войди, чтобы сохранять игры.'); return; }
  state.saved = state.saved.includes(id) ? state.saved.filter((savedId) => savedId !== id) : [...state.saved, id];
  persist(); renderCatalog(); renderLibrary(); toast(state.saved.includes(id) ? 'Игра добавлена в библиотеку' : 'Игра убрана из библиотеки');
}
function downloadGame(id) {
  if (!state.currentUser) { openModal('authModal'); showAuthMessage('Войди, чтобы скачать игру.'); return; }
  fetch(`/api/games/${encodeURIComponent(id)}/download`, { headers: currentHeaders() })
    .then(async (response) => { if (!response.ok) { const error = await response.json(); throw new Error(error.message); } return response.blob(); })
    .then((blob) => { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = state.games.find((game) => game.id === id)?.fileName || 'game-download'; link.click(); URL.revokeObjectURL(link.href); const game = state.games.find((item) => item.id === id); if (game) game.downloads = (game.downloads || 0) + 1; toast('Скачивание началось'); if ($('#detailTitle').textContent === game?.title) $('#detailDownloads').textContent = game.downloads; })
    .catch((error) => toast(error.message || 'Не удалось скачать игру.'));
}
function openGame(id) {
  const game = state.games.find((item) => item.id === id);
  if (!game) return;
  ['discover', 'library', 'studio', 'moderation'].forEach((section) => $(`#${section}`).classList.add('is-hidden'));
  $('#gameDetail').classList.remove('is-hidden');
  history.pushState({}, '', `#game/${encodeURIComponent(id)}`);
  fetch(`/api/games/${encodeURIComponent(id)}`, { headers: currentHeaders() }).then((response) => response.json()).then((fullGame) => { const index = state.games.findIndex((item) => item.id === id); if (index >= 0) state.games[index] = { ...state.games[index], ...fullGame }; loadGameDetail(fullGame); }).catch(() => loadGameDetail(game));
  window.scrollTo({ top: document.querySelector('main').offsetTop - 20, behavior: 'smooth' });
}
function loadGameDetail(game) {
  $('#detailCover').style.backgroundColor = game.color;
  $('#detailCover').style.backgroundImage = game.coverUrl ? `url('${game.coverUrl}')` : '';
  $('#detailGenre').textContent = `${game.genre} / ${isRecentRelease(game) ? 'новый релиз' : 'релиз'}`;
  $('#detailTitle').textContent = game.title;
  $('#detailDeveloper').textContent = `от ${game.developer}`;
  $('#detailDescription').textContent = game.description;
  $('#detailDownloads').textContent = game.downloads || 0;
  $('#detailLikes').textContent = game.likes || 0;
  $('#detailDislikes').textContent = game.dislikes || 0;
  $('#detailSave').textContent = state.saved.includes(game.id) ? '✓ В библиотеке' : '+ В библиотеку';
  $('#detailDownload').onclick = () => downloadGame(game.id);
  $('#detailSave').onclick = () => { toggleSaved(game.id); $('#detailSave').textContent = state.saved.includes(game.id) ? '✓ В библиотеке' : '+ В библиотеку'; };
  $('#likeButton').onclick = () => reactToGame(game.id, 'like');
  $('#dislikeButton').onclick = () => reactToGame(game.id, 'dislike');
  $('#reviewForm').dataset.gameId = game.id;
  $('#reviewForm').dataset.reviewId = '';
  $('#reviewText').value = '';
  $('#reviewSubmit').innerHTML = 'Оставить отзыв <span>↗</span>';
  $('#reviewCancel').classList.add('is-hidden');
  $('#reviewsList').innerHTML = (game.reviews || []).length ? game.reviews.map((review) => { const reactionLabel = review.reaction === 'like' ? 'лайкнул игру' : review.reaction === 'dislike' ? 'дизлайкнул игру' : ''; const canManage = review.isOwner || state.currentUser?.role === 'moderator'; return `<article class="review"><div><strong>${escapeHtml(review.nickname)}</strong>${reactionLabel ? `<span class="review-reaction">${reactionLabel}</span>` : ''}<span>${new Date(review.createdAt).toLocaleDateString('ru-RU')}</span>${canManage ? `<button class="review-edit" data-review-id="${escapeHtml(review.id)}">Редактировать</button><button class="review-edit review-delete" data-delete-review-id="${escapeHtml(review.id)}">Удалить</button>` : ''}</div><p>${escapeHtml(review.text)}</p></article>`; }).join('') : '<p class="no-reviews">Пока нет отзывов. Будь первым.</p>';
  $$('#reviewsList [data-review-id]').forEach((button) => button.addEventListener('click', () => { const review = game.reviews.find((item) => item.id === button.dataset.reviewId); if (!review) return; $('#reviewForm').dataset.reviewId = review.id; $('#reviewText').value = review.text; $('#reviewSubmit').innerHTML = 'Сохранить изменения <span>↗</span>'; $('#reviewCancel').classList.remove('is-hidden'); $('#reviewText').focus(); }));
  $$('#reviewsList [data-delete-review-id]').forEach((button) => button.addEventListener('click', () => { if (!confirm('Удалить отзыв?')) return; fetch(`/api/games/${encodeURIComponent(game.id)}/reviews/${encodeURIComponent(button.dataset.deleteReviewId)}`, { method: 'DELETE', headers: currentHeaders() }).then(() => { button.closest('.review').remove(); toast('Отзыв удален'); }); }));
}
function reactToGame(id, type) {
  if (!state.currentUser) { openModal('authModal'); showAuthMessage('Войди, чтобы оценить игру.'); return; }
  fetch(`/api/games/${encodeURIComponent(id)}/reaction`, { method: 'POST', headers: { ...currentHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) })
    .then((response) => response.json())
    .then((metrics) => { $('#detailLikes').textContent = metrics.likes; $('#detailDislikes').textContent = metrics.dislikes; toast(type === 'like' ? 'Лайк поставлен' : 'Дизлайк поставлен'); })
    .catch(() => toast('Не удалось сохранить реакцию.'));
}
function navigate(route) {
  $$('.nav-link').forEach((link) => link.classList.toggle('is-active', link.dataset.route === route));
  ['discover', 'library', 'studio', 'moderation', 'gameDetail'].forEach((id) => $(`#${id}`).classList.toggle('is-hidden', id !== route));
  if (route === 'library') renderLibrary();
  if (route === 'studio' && (!state.currentUser || !['developer', 'moderator'].includes(state.currentUser.role))) { openModal('authModal'); showAuthMessage('Нужен аккаунт разработчика или модератора.'); navigate('discover'); }
  if (route === 'moderation' && (!state.currentUser || state.currentUser.role !== 'moderator')) { openModal('authModal'); showAuthMessage('Раздел доступен только модераторам.'); navigate('discover'); }
  if (route === 'moderation') loadModeration();
  window.scrollTo({ top: document.querySelector('main').offsetTop - 20, behavior: 'smooth' });
}
function openModal(id) { $(`#${id}`).classList.remove('is-hidden'); document.body.style.overflow = 'hidden'; }
function closeModal(id) { $(`#${id}`).classList.add('is-hidden'); document.body.style.overflow = ''; }
function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('is-visible'); setTimeout(() => element.classList.remove('is-visible'), 2600); }
function showAuthMessage(message = '') { $('#authMessage').textContent = message; }
function setAuthMode(mode) { state.authMode = mode; $$('#authModal [data-auth-mode]').forEach((button) => button.classList.toggle('is-active', button.dataset.authMode === mode)); $$('.register-field').forEach((field) => field.classList.toggle('is-hidden', mode !== 'register')); $('#authTitle').textContent = mode === 'login' ? 'Добро пожаловать' : 'Создай аккаунт'; $('#authSubmit').innerHTML = mode === 'login' ? 'Войти <span>↗</span>' : 'Зарегистрироваться <span>↗</span>'; showAuthMessage(); }

$('#searchToggle').addEventListener('click', () => { $('#searchBox').classList.toggle('is-open'); $('#searchInput').focus(); });
$('#searchInput').addEventListener('input', (event) => { const query = event.target.value.toLowerCase(); $$('#gamesGrid .game-card').forEach((card) => card.classList.toggle('is-hidden', !card.textContent.toLowerCase().includes(query))); });
$('#profileButton').addEventListener('click', () => $('#profileMenu').classList.toggle('is-open'));
$('#openAuth').addEventListener('click', () => { $('#profileMenu').classList.remove('is-open'); openModal('authModal'); });
$('#logoutButton').addEventListener('click', () => { state.currentUser = null; persist(); updateProfile(); $('#profileMenu').classList.remove('is-open'); toast('Ты вышел из аккаунта'); });
$$('[data-route]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); navigate(link.dataset.route); }));
$$('[data-close]').forEach((button) => button.addEventListener('click', () => closeModal(button.dataset.close)));
$$('[data-auth-mode]').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
$$('.filter-tab').forEach((button) => button.addEventListener('click', () => { state.filter = button.dataset.filter; $$('.filter-tab').forEach((tab) => tab.classList.toggle('is-active', tab === button)); renderCatalog(); }));
$('#addGameButton').addEventListener('click', () => openModal('gameModal'));
$('#backToCatalog').addEventListener('click', () => { history.pushState({}, '', '#discover'); navigate('discover'); });
$('#reviewForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const reviewForm = event.currentTarget;
  if (!state.currentUser) { openModal('authModal'); showAuthMessage('Войди, чтобы оставить отзыв.'); return; }
  const gameId = reviewForm.dataset.gameId;
  const reviewId = reviewForm.dataset.reviewId;
  const isEditing = Boolean(reviewId);
  fetch(`/api/games/${encodeURIComponent(gameId)}/reviews${isEditing ? `/${encodeURIComponent(reviewId)}` : ''}`, { method: isEditing ? 'PUT' : 'POST', headers: { ...currentHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: state.currentUser.nickname, text: $('#reviewText').value }) })
    .then(async (response) => { const review = await response.json(); if (!response.ok) throw new Error(review.message); return review; })
    .then((review) => { const list = $('#reviewsList'); if (isEditing) { const current = list.querySelector(`[data-review-id="${CSS.escape(review.id)}"]`); const article = current?.closest('.review'); if (article) article.querySelector('p').textContent = review.text; } else { if (list.querySelector('.no-reviews')) list.innerHTML = ''; list.insertAdjacentHTML('afterbegin', `<article class="review"><div><strong>${escapeHtml(review.nickname)}</strong>${review.reaction ? `<span class="review-reaction">${review.reaction === 'like' ? 'лайкнул игру' : 'дизлайкнул игру'}</span>` : ''}<span>сейчас</span><button class="review-edit" data-review-id="${escapeHtml(review.id)}">Редактировать</button></div><p>${escapeHtml(review.text)}</p></article>`); const editButton = list.querySelector(`[data-review-id="${CSS.escape(review.id)}"]`); editButton.addEventListener('click', () => { reviewForm.dataset.reviewId = review.id; $('#reviewText').value = review.text; $('#reviewSubmit').innerHTML = 'Сохранить изменения <span>↗</span>'; $('#reviewCancel').classList.remove('is-hidden'); }); } reviewForm.reset(); reviewForm.dataset.reviewId = ''; $('#reviewCancel').classList.add('is-hidden'); $('#reviewSubmit').innerHTML = 'Оставить отзыв <span>↗</span>'; toast(isEditing ? 'Отзыв обновлен' : 'Отзыв опубликован'); })
    .catch((error) => toast(error.message || 'Не удалось отправить отзыв.'));
});
$('#reviewCancel').addEventListener('click', () => { $('#reviewForm').reset(); $('#reviewForm').dataset.reviewId = ''; $('#reviewCancel').classList.add('is-hidden'); $('#reviewSubmit').innerHTML = 'Оставить отзыв <span>↗</span>'; });

$('#authForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const email = $('#authEmail').value.trim().toLowerCase(); const password = $('#authPassword').value; const nickname = $('#authNickname').value.trim(); const role = $('#authRole').value;
  if (state.authMode === 'register') {
    if (!nickname) { showAuthMessage('Придумай никнейм.'); return; }
    if (state.users.some((user) => user.email === email)) { showAuthMessage('Такой email уже зарегистрирован.'); return; }
    state.users.push({ email, password, nickname, role }); state.currentUser = { email, nickname, role }; toast(`Аккаунт ${nickname} создан`);
  } else {
    const user = state.users.find((item) => item.email === email && item.password === password);
    if (!user) { showAuthMessage('Неверный email или пароль.'); return; }
    state.currentUser = { email: user.email, nickname: user.nickname, role: user.role }; toast(`С возвращением, ${user.nickname}`);
  }
  persist(); updateProfile(); closeModal('authModal'); event.target.reset(); syncCurrentUserPermissions();
});

$('#gameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state.currentUser) { showAuthMessage('Войди, чтобы публиковать игры.'); return; }
  const formData = new FormData();
  formData.append('title', $('#gameTitle').value.trim());
  formData.append('description', $('#gameDescription').value.trim());
  formData.append('genre', $('#gameGenre').value);
  formData.append('color', $('#gameColor').value);
  formData.append('developer', state.currentUser.nickname);
  formData.append('developerEmail', state.currentUser.email);
  formData.append('gameFile', $('#gameFile').files[0]);
  formData.append('coverImage', $('#coverImage').files[0]);
  const submitButton = $('#gameForm button[type="submit"]');
  submitButton.disabled = true;
  submitButton.firstChild.textContent = 'Загрузка... ';
  fetch('/api/games', { method: 'POST', headers: currentHeaders(), body: formData })
    .then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.message); return payload; })
    .then(() => { renderCatalog(); renderStudio(); closeModal('gameModal'); event.target.reset(); toast('Игра отправлена на проверку'); })
    .catch((error) => { $('#gameMessage').textContent = error.message || 'Не удалось загрузить игру.'; })
    .finally(() => { submitButton.disabled = false; submitButton.firstChild.textContent = 'Опубликовать игру '; });
});

document.addEventListener('click', (event) => { if (!event.target.closest('.profile-menu') && !event.target.closest('#profileButton')) $('#profileMenu').classList.remove('is-open'); });
window.addEventListener('hashchange', () => { const route = location.hash.replace('#', '') || 'discover'; if (route.startsWith('game/')) { if (state.games.length) openGame(decodeURIComponent(route.slice(5))); } else navigate(route); });
window.addEventListener('popstate', () => navigate('discover'));
const initialRoute = location.hash.replace('#', '') || 'discover';
fetch('/api/games')
  .then((response) => response.json())
  .then((games) => { state.games = games; renderCatalog(); renderLibrary(); renderStudio(); if (initialRoute.startsWith('game/')) openGame(decodeURIComponent(initialRoute.slice(5))); })
  .catch(() => { $('#emptyState').classList.remove('is-hidden'); $('#emptyState h3').textContent = 'Сервер не запущен'; $('#emptyState p').textContent = 'Запусти npm install, затем npm start.'; });
updateProfile();
syncCurrentUserPermissions();
if (!initialRoute.startsWith('game/')) navigate(initialRoute);
