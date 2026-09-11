/* Isolated design fixture. No application imports, API calls, or persistence. */
const params = new URLSearchParams(location.search);
const concept = params.get('concept') === 'cool' ? 'cool' : 'warm';
const page = params.get('page') === 'library' ? 'library' : 'home';
const asset = '../../../public/';
const paths = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  books:
    '<path d="M3 4h7a2 2 0 0 1 2 2v15a3 3 0 0 0-3-2H3zM21 4h-7a2 2 0 0 0-2 2v15a3 3 0 0 1 3-2h6z"/>',
  spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4zM20 2v4m-2-2h4"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  heart:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0l-1 1-1-1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  filter:
    '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="var(--surface)"/><circle cx="16" cy="12" r="2" fill="var(--surface)"/><circle cx="10" cy="18" r="2" fill="var(--surface)"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 1 1 5 2.2c-1.4 1-2 1.1-2 3.3M12 17h.01"/>',
  settings:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
};
const icon = (name) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.books}</svg>`;
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const href = (p, extra = '') => `prototype.html?concept=${concept}&page=${p}${extra}`;
const books = [
  {
    id: 1,
    title: 'The Dispossessed',
    author: 'Ursula K. Le Guin',
    shelf: 'read',
    rating: 5,
    favorite: true,
    genre: 'Science fiction',
    date: 'Sep 8, 2026',
    bg: '#943f39',
    ink: '#ffe8bf',
  },
  {
    id: 2,
    title: 'The Remains of the Day',
    author: 'Kazuo Ishiguro',
    shelf: 'read',
    rating: 4.5,
    favorite: true,
    genre: 'Literary fiction',
    date: 'Aug 29, 2026',
    bg: '#beac7d',
    ink: '#29271e',
  },
  {
    id: 3,
    title: 'Jonathan Strange & Mr Norrell',
    author: 'Susanna Clarke',
    shelf: 'read',
    rating: 4.5,
    favorite: false,
    genre: 'Fantasy',
    date: 'Aug 16, 2026',
    bg: '#31444a',
    ink: '#ede1c5',
  },
  {
    id: 4,
    title: 'A Psalm for the Wild-Built',
    author: 'Becky Chambers',
    shelf: 'read',
    rating: 4,
    favorite: false,
    genre: 'Science fiction',
    date: 'Jul 21, 2026',
    bg: '#476345',
    ink: '#fff0ca',
  },
  {
    id: 5,
    title: 'The Ocean at the End of the Lane',
    author: 'Neil Gaiman',
    shelf: 'read',
    rating: null,
    favorite: false,
    genre: 'Fantasy',
    date: 'Jun 30, 2026',
    missing: true,
  },
  {
    id: 6,
    title: 'The Fifth Season',
    author: 'N. K. Jemisin',
    shelf: 'read',
    rating: 4,
    favorite: false,
    genre: 'Fantasy',
    date: 'Jun 2, 2026',
    bg: '#78604b',
    ink: '#ffecce',
  },
  {
    id: 7,
    title: 'The Left Hand of Darkness',
    author: 'Ursula K. Le Guin',
    shelf: 'reading',
    rating: null,
    favorite: false,
    genre: 'Science fiction',
    bg: '#bec8c4',
    ink: '#203a3b',
  },
  {
    id: 8,
    title: 'Never Let Me Go',
    author: 'Kazuo Ishiguro',
    shelf: 'reading',
    rating: null,
    favorite: false,
    genre: 'Literary fiction',
    bg: '#ad773a',
    ink: '#fff3cf',
  },
  {
    id: 9,
    title: 'Piranesi',
    author: 'Susanna Clarke',
    shelf: 'to-read',
    rating: null,
    favorite: false,
    genre: 'Fantasy',
    image: asset + 'marketing/piranesi-cover.jpg',
  },
  {
    id: 10,
    title: 'A Wizard of Earthsea',
    author: 'Ursula K. Le Guin',
    shelf: 'to-read',
    rating: null,
    favorite: false,
    genre: 'Fantasy',
    bg: '#466563',
    ink: '#fce9b8',
  },
  {
    id: 11,
    title: 'Klara and the Sun',
    author: 'Kazuo Ishiguro',
    shelf: 'to-read',
    rating: null,
    favorite: false,
    genre: 'Literary fiction',
    bg: '#9d442b',
    ink: '#ffe8b0',
  },
  {
    id: 12,
    title: 'The Starless Sea',
    author: 'Erin Morgenstern',
    shelf: 'dnf',
    rating: null,
    favorite: false,
    genre: 'Fantasy',
    bg: '#34495c',
    ink: '#f1c883',
  },
];
let shelf = ['read', 'reading', 'to-read', 'dnf', 'rejected'].includes(params.get('shelf'))
  ? params.get('shelf')
  : 'read';
let query = '',
  favoriteOnly = false,
  minimumRating = 0,
  sort = 'recent';
const cover = (b) =>
  b.image
    ? `<div class="cover-wrap"><img class="cover" src="${b.image}" alt="Cover of ${esc(b.title)}" /></div>`
    : b.missing
      ? `<div class="cover-wrap"><div class="cover cover-missing" role="img" aria-label="No cover available">${icon('books')}<span>No cover</span></div></div>`
      : `<div class="cover-wrap"><div class="cover book-fallback" style="--book-bg:${b.bg};--book-ink:${b.ink}" role="img" aria-label="Typographic placeholder for ${esc(b.title)}"><strong>${esc(b.title)}</strong><span>${esc(b.author)}</span></div></div>`;
const routes = [
  ['home', 'Home', 'home'],
  ['for-you', 'For you', 'spark'],
  ['discover', 'Discover', 'compass'],
  ['library', 'Library', 'books'],
  ['profile', 'Profile', 'user'],
];
const nav = () =>
  routes
    .map(
      ([p, label, i]) =>
        `<a class="nav-link ${page === p ? 'active' : ''}" ${page === p ? 'aria-current="page"' : ''} href="${href(p)}" ${!['home', 'library'].includes(p) ? `data-preview="${p}"` : ''}>${icon(i)}<span>${label}</span></a>`
    )
    .join('');
const logo = `<a href="${href('home')}" aria-label="ShelfSprite Home"><img class="logo" src="${asset}shelfsprite-logo-kit/shelfsprite-logo-dark.svg" alt="ShelfSprite" /></a>`;
const shell = (content) => `
  <header class="topbar">${logo}<nav class="nav-links" aria-label="Primary">${nav()}</nav><div class="account"><button class="text-button help-desktop" data-help>Help</button><button class="avatar" data-account aria-label="Open account menu">AR</button><button class="icon-button mobile-account" data-account aria-label="Open account and help">${icon('user')}</button></div></header>
  <aside class="rail">${logo}<nav class="nav-links" aria-label="Primary">${nav()}</nav><div class="rail-bottom"><button class="text-button" data-preview="settings">${icon('settings')} Settings</button><button class="text-button" data-help>${icon('help')} Help & feedback</button><button class="rail-user" data-account><span class="avatar">AR</span><span>Alex's reading room<small>Your account</small></span></button></div></aside>
  <main id="main" class="main">${content}<footer class="quiet-footer"><span class="review-label">${concept === 'cool' ? 'B · INK & PAPER' : 'A · EMBER & IVORY'} · SAMPLE LIBRARY</span><a href="index.html">Back to design comparison ↗</a></footer></main>
  <nav class="mobile-nav" aria-label="Mobile primary">${nav()}</nav>`;
const identity = () =>
  `<div class="identity"><img src="${asset}reader-types/icbh-empathic-rover.webp" alt="" /><div><p class="eyebrow">Your reader type</p><h3>The Empathic Rover</h3><a href="${href('profile')}" data-preview="profile">Explore your taste <span aria-hidden="true">↗</span></a></div></div>`;
const home = () => `
  <header class="page-top"><div><p class="eyebrow">Your reading room</p><h1>Good to see you, Alex.</h1><a class="mobile-identity" href="${href('profile')}" data-preview="profile"><img src="${asset}reader-types/icbh-empathic-rover.webp" alt="" />The Empathic Rover <span aria-hidden="true">↗</span></a></div><span class="date">Friday, September 11</span></header>
  <div class="home-grid"><div class="home-primary"><section class="lead" aria-labelledby="next-title"><div><p class="eyebrow">A good book changes the day</p><h2 id="next-title">Find your next favorite.</h2><p>Something strange, something moving, something you can't put down.</p><button class="button primary" data-preview="recommend">Find my next books <span aria-hidden="true">↗</span></button></div><div><button data-book="9" aria-label="Open Piranesi">${cover(books[8])}</button><p class="cover-caption">On your to-read shelf</p></div></section>
  <section class="reading" aria-labelledby="reading-title"><div class="section-head"><h2 id="reading-title">Between the pages</h2><a class="text-button" href="${href('library', '&shelf=reading')}">Reading · 2 <span aria-hidden="true">→</span></a></div><div class="reading-list">${books
    .filter((b) => b.shelf === 'reading')
    .map(
      (b) =>
        `<article class="reading-book">${cover(b)}<div><h3><a href="#book-${b.id}" data-book="${b.id}">${esc(b.title)}</a></h3><p class="muted">${esc(b.author)}</p><button class="text-button" data-finish="${b.id}">Mark finished <span aria-hidden="true">↗</span></button></div></article>`
    )
    .join('')}</div></section>
  <section class="next-shelf"><div class="section-head"><h3>Already on your mind</h3><a class="text-button" href="${href('library', '&shelf=to-read')}">To read · 3 <span aria-hidden="true">→</span></a></div><p>Piranesi, A Wizard of Earthsea, and Klara and the Sun are waiting on your shelf.</p></section></div>
  <aside class="home-aside" aria-label="Your reading life">${identity()}<section class="goal"><div class="section-head"><h3>A little every day</h3><span class="eyebrow">2026</span></div><div class="goal-number">6 <small>of 12 books</small></div><div class="track" role="progressbar" aria-label="2026 reading goal" aria-valuenow="6" aria-valuemin="0" aria-valuemax="12"><i></i></div><p>Halfway to your reading goal.</p><button class="text-button" data-preview="goals">View reading goals <span aria-hidden="true">→</span></button></section></aside></div>`;
const shelfItems = [
  ['read', 'Read'],
  ['to-read', 'To read'],
  ['reading', 'Reading'],
  ['dnf', 'DNF'],
  ['rejected', 'Rejected'],
];
const library =
  () => `<header class="page-top library-top"><div><div class="library-heading"><h1>Your library</h1><span>12 books</span></div><p class="muted">The books you've lived in, and the ones still waiting.</p></div><button class="button secondary" data-preview="add">${icon('plus')} Add book</button></header>
  <nav class="shelves" aria-label="Library shelves">${shelfItems.map(([id, label]) => `<button class="shelf ${shelf === id ? 'active' : ''}" data-shelf="${id}" aria-pressed="${shelf === id}">${label}<span>${books.filter((b) => b.shelf === id).length}</span></button>`).join('')}</nav>
  <div class="library-controls"><div class="toolbar"><label class="search-box">${icon('search')}<input type="search" id="search" aria-label="Search title or author on this shelf" placeholder="Search title or author…" /></label><button class="button secondary filter-button" id="filters" aria-expanded="false" aria-controls="filter-tray">${icon('filter')} Filters <span id="filter-count"></span></button><select id="sort" aria-label="Sort books"><option value="recent">Recently read</option><option value="title">Title A–Z</option><option value="rating">Rating: high first</option></select></div>
  <div class="filter-tray" id="filter-tray" hidden><label><input type="checkbox" id="favorites" />Favorites only</label><label>Rating<select id="rating-filter"><option value="0">Any rating</option><option value="4.5">4.5 and above</option><option value="4">4 and above</option></select></label><button class="text-button" id="reset">Clear filters</button><button class="text-button review-link-mobile" data-preview="review-queue">Review unrated · 1 →</button></div>
  <div class="results-bar"><span id="results-count" role="status"></span><button class="text-button" data-preview="review-queue">Review unrated · 1 <span aria-hidden="true">→</span></button></div>
  </div><div class="column-head" aria-hidden="true"><span>Book</span><span>Your rating</span><span class="date-heading">Date read</span><span>Love</span></div><div id="book-list"></div>`;
document.body.className = concept;
document.title = `${page === 'home' ? 'Home' : 'Library'} · ${concept === 'cool' ? 'Ink & Paper' : 'Ember & Ivory'} · ShelfSprite concept`;
document.getElementById('app').innerHTML = shell(page === 'home' ? home() : library());
function renderBooks() {
  const list = books.filter(
    (b) =>
      b.shelf === shelf &&
      `${b.title} ${b.author}`.toLowerCase().includes(query.toLowerCase()) &&
      (!favoriteOnly || b.favorite) &&
      (!minimumRating || b.rating >= minimumRating)
  );
  if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'rating') list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  document.getElementById('results-count').textContent =
    `${list.length} ${list.length === 1 ? 'book' : 'books'}${query || favoriteOnly || minimumRating ? ' matching' : ''} · ${shelfItems.find((x) => x[0] === shelf)[1]}`;
  document.getElementById('filter-count').textContent =
    favoriteOnly || minimumRating ? `· ${Number(favoriteOnly) + Number(!!minimumRating)}` : '';
  document.querySelectorAll('[data-preview="review-queue"]').forEach((el) => {
    el.hidden = shelf !== 'read';
  });
  document.querySelector('.column-head').style.visibility = list.length ? 'visible' : 'hidden';
  document.querySelector('.column-head span:nth-child(2)').textContent =
    shelf === 'read' ? 'Your rating' : 'Next action';
  document.querySelector('.date-heading').textContent = shelf === 'read' ? 'Date read' : 'Shelf';
  document.getElementById('book-list').innerHTML = list.length
    ? list
        .map(
          (b) =>
            `<article class="book-row">${cover(b)}<div class="book-info"><button class="book-title" data-book="${b.id}">${esc(b.title)}</button><p class="book-author">${esc(b.author)}</p><p class="book-genre">${esc(b.genre)}</p></div>${shelf === 'read' ? `<button class="rating" data-rating="${b.id}" aria-label="${esc(b.title)}: ${b.rating ? `${b.rating} out of 5 stars` : 'unrated'}. Edit rating.">${b.rating ? `<span class="star" aria-hidden="true">★</span> ${b.rating.toFixed(1)} <span class="muted">/ 5</span>` : '<span class="unrated">Add a rating</span>'}</button>` : `<button class="row-action" ${shelf === 'reading' ? `data-finish="${b.id}"` : `data-book="${b.id}"`}>${shelf === 'reading' ? 'Mark finished' : shelf === 'to-read' ? 'Start reading' : 'View details'} →</button>`}<span class="book-date">${b.date || shelfItems.find((x) => x[0] === b.shelf)[1]}</span><button class="favorite" data-favorite="${b.id}" aria-pressed="${b.favorite}" aria-label="Favorite ${esc(b.title)}">${icon('heart')}</button></article>`
        )
        .join('')
    : `<section class="empty"><img src="${asset}shelfsprite-sleep.png" alt=""/><h2>${shelf === 'rejected' ? 'No rejected books' : 'No books here yet'}</h2><p>${query || favoriteOnly || minimumRating ? 'Try another search or clear your filters.' : 'Your books will appear here when you move them to this shelf.'}</p>${query || favoriteOnly || minimumRating ? '<button class="button secondary" id="clear-search">Clear search & filters</button>' : ''}</section>`;
}
if (page === 'library') {
  renderBooks();
  document.getElementById('search').addEventListener('input', (e) => {
    query = e.target.value;
    renderBooks();
  });
  document.getElementById('sort').addEventListener('change', (e) => {
    sort = e.target.value;
    renderBooks();
  });
  document.getElementById('favorites').addEventListener('change', (e) => {
    favoriteOnly = e.target.checked;
    renderBooks();
  });
  document.getElementById('rating-filter').addEventListener('change', (e) => {
    minimumRating = Number(e.target.value);
    renderBooks();
  });
}
const dialog = document.getElementById('dialog');
function show(title, body) {
  document.getElementById('dialog-content').innerHTML =
    `<h2 id="dialog-title">${title}</h2>${body}`;
  if (!dialog.open) dialog.showModal();
}
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('visible'), 3500);
}
function reset() {
  favoriteOnly = false;
  minimumRating = 0;
  document.getElementById('favorites').checked = false;
  document.getElementById('rating-filter').value = '0';
  renderBooks();
}
const previews = {
  recommend: [
    'Find your next books',
    'This action would request new recommendations after checking that your taste profile is current. The final flow must keep generation cost and duration visible. No recommendations are generated in this design preview.',
  ],
  'for-you': [
    'For you',
    'Proposed name for Swipe. Your existing recommendations and decision controls would live here. This exploration covers Home and Library only.',
  ],
  discover: [
    'What are you in the mood to read?',
    'Discover keeps its own destination. A future design pass will explore prompts and book results after you choose a visual direction.',
  ],
  profile: [
    'Your reader type',
    'The full reader sprite, taste traits, and axes stay in Profile. Home carries a compact identity link.',
  ],
  settings: [
    'Settings',
    'Themes could be selected here if theme switching is approved. These two concepts are alternatives under review.',
  ],
  goals: [
    'Your reading goals',
    'The existing reading-goal controls would open here. Sample progress: 6 of 12 books.',
  ],
  add: [
    'Add a book',
    'The existing catalog search-and-pick flow would open here. This preview does not search or add catalog records.',
  ],
  'review-queue': [
    'A moment for your last read',
    'The existing unrated-book queue would open here. It remains reachable without a permanent full-width callout above the books.',
  ],
};
document.addEventListener('click', (e) => {
  const target = e.target.closest('button,a');
  if (!target) return;
  if (target.hasAttribute('data-close')) {
    dialog.close();
    return;
  }
  if (target.dataset.preview) {
    e.preventDefault();
    const [title, body] = previews[target.dataset.preview];
    show(
      title,
      `<p>${body}</p><button class="button secondary" data-close>Back to the concept</button>`
    );
    return;
  }
  if (target.hasAttribute('data-help')) {
    show(
      'A little help',
      `<p>Feedback stays here, within easy reach.</p><div class="menu"><button class="button secondary" data-feedback>Share feedback</button><button class="button secondary" data-guide>Reading & library help</button></div>`
    );
    return;
  }
  if (target.hasAttribute('data-account')) {
    show(
      'Your account',
      `<div class="menu"><button class="button secondary" data-preview="settings">Settings</button><button class="button secondary" data-help>Help & feedback</button><button class="button secondary" data-preview="profile">Your reader profile</button></div>`
    );
    return;
  }
  if (target.hasAttribute('data-guide')) {
    show(
      'Make yourself at home',
      '<p>Use shelves to move between read, to-read, currently reading, DNF, and rejected books. Search and filters narrow the current shelf.</p><button class="button secondary" data-help>Back to Help</button>'
    );
    return;
  }
  if (target.hasAttribute('data-feedback')) {
    show(
      'Share feedback',
      '<p>This is a local preview of the feedback entry point. Nothing is submitted.</p><label for="feedback-note">What would make ShelfSprite better?</label><textarea id="feedback-note" placeholder="Tell us what you noticed…"></textarea><button class="button secondary" data-close>Close preview</button>'
    );
    return;
  }
  if (target.id === 'filters') {
    const tray = document.getElementById('filter-tray');
    tray.hidden = !tray.hidden;
    target.setAttribute('aria-expanded', String(!tray.hidden));
    return;
  }
  if (target.id === 'reset') {
    reset();
    return;
  }
  if (target.id === 'clear-search') {
    query = '';
    document.getElementById('search').value = '';
    reset();
    return;
  }
  if (target.dataset.shelf) {
    shelf = target.dataset.shelf;
    document.querySelectorAll('.shelf').forEach((el) => {
      el.classList.toggle('active', el.dataset.shelf === shelf);
      el.setAttribute('aria-pressed', String(el.dataset.shelf === shelf));
    });
    document.querySelector('#sort option[value="recent"]').textContent =
      shelf === 'read' ? 'Recently read' : 'Shelf order';
    renderBooks();
    return;
  }
  if (target.dataset.favorite) {
    const b = books.find((x) => x.id === Number(target.dataset.favorite));
    b.favorite = !b.favorite;
    renderBooks();
    const replacement = document.querySelector(`[data-favorite="${b.id}"]`);
    if (replacement) replacement.focus();
    else document.getElementById('favorites').focus();
    toast(`${b.favorite ? 'Added to' : 'Removed from'} sample favorites. Resets on reload.`);
    return;
  }
  const bookId = target.dataset.book || target.dataset.finish || target.dataset.rating;
  if (bookId) {
    e.preventDefault();
    const b = books.find((x) => x.id === Number(bookId));
    if (target.dataset.finish || target.dataset.rating) {
      show(
        target.dataset.finish ? `Finished ${esc(b.title)}?` : 'Your rating',
        `<p>The existing half-star rating and review editor would open here${target.dataset.finish ? ', after moving this book to Read' : ''}. No shelf or rating changes are saved in this preview.</p><p class="detail-meta">${esc(b.title)} · ${b.rating ? `${b.rating} / 5` : 'Not rated'}</p><button class="button secondary" data-close>Back to reading</button>`
      );
    } else
      show(
        esc(b.title),
        `<div class="detail-cover">${cover(b)}</div><p>${esc(b.author)}</p><p class="detail-meta">${esc(b.genre)} · ${shelfItems.find((x) => x[0] === b.shelf)[1]}</p><p>Book details and the existing shelf actions would open here.</p><button class="button primary" ${b.shelf === 'reading' ? `data-finish="${b.id}"` : 'data-start'}>${b.shelf === 'reading' ? 'Mark finished' : b.shelf === 'to-read' ? 'Start reading' : 'Edit rating & review'}</button>`
      );
    return;
  }
  if (target.hasAttribute('data-start')) {
    show(
      'Reading action preview',
      '<p>This would use the existing shelf or rating flow. No changes are saved here.</p><button class="button secondary" data-close>Back to the concept</button>'
    );
  }
});
