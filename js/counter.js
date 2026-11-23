// The visitor counter in the title row: how many different people have opened
// Patch Bay, and how many times it has been opened in all.
//
// A page with no server of its own has nowhere to keep a count — nothing on the
// device knows about anyone else's visit — so the numbers come from Abacus
// (abacus.jasoncameron.dev), a free counter with CORS open to any page. Every
// visit asks it to add one to "views"; a browser that has never been counted
// before also adds one to "users", which is what makes that the number of
// different people rather than of visits. The marker saying this browser has
// been counted, and the last numbers it saw, are kept in localStorage.
//
// A plain script, so the count is there whether or not the synth's module graph
// loads, and it never holds anything else up: the chip appears when a number
// arrives, and stays hidden if the service cannot be reached.
(function () {
  'use strict';

  const chip = document.getElementById('viewer-count');
  const userStat = document.getElementById('viewer-users-stat');
  const viewStat = document.getElementById('viewer-views-stat');
  if (!chip || !userStat || !viewStat) return;

  const userNum = userStat.querySelector('b');
  const userWord = userStat.querySelector('i');
  const viewNum = viewStat.querySelector('b');
  const viewWord = viewStat.querySelector('i');
  if (!userNum || !viewNum) return;

  // The namespace is the site's own name, so no other page shares the count.
  const API = 'https://abacus.jasoncameron.dev';
  const SPACE = 'patch-bay-fm3w';
  const SEEN = 'patchbay.seen.v1'; // this browser has been counted among the users
  const LAST = 'patchbay.count.v1'; // the last numbers it was shown, to show at once

  function read(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null; // private browsing, or storage turned off
    }
  }

  function write(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      /* private browsing, or storage turned off */
    }
  }

  function format(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return String(n);
    try {
      return v.toLocaleString();
    } catch (e) {
      return String(v);
    }
  }

  const counts = { users: null, views: null };

  function remember() {
    write(LAST, JSON.stringify(counts));
  }

  function show(stat, num, word, value, one, many) {
    if (value == null) return;
    num.textContent = format(value);
    if (word) word.textContent = value === 1 ? one : many;
    stat.hidden = false;
    chip.hidden = false;
  }

  // One request to the counter, resolving to its value, or to null when the
  // service could not be reached — offline, blocked, or out of requests. A page
  // that cannot count shows no number rather than a wrong one.
  function ask(path) {
    return fetch(API + path, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => (data && typeof data.value === 'number' ? data.value : null))
      .catch(() => null);
  }

  // What the last visit was shown, so the numbers are there straight away and
  // stay there if this one cannot reach the service.
  const raw = read(LAST);
  if (raw) {
    try {
      const saved = JSON.parse(raw);
      if (saved && typeof saved.users === 'number') counts.users = saved.users;
      if (saved && typeof saved.views === 'number') counts.views = saved.views;
    } catch (e) {
      /* an old or half-written value: start from nothing */
    }
  }
  show(userStat, userNum, userWord, counts.users, 'user', 'users');
  show(viewStat, viewNum, viewWord, counts.views, 'view', 'views');

  // Every visit is a view. A browser that has not been counted before is also a
  // user; one that has simply asks for the number.
  const seen = read(SEEN) === '1';

  ask('/hit/' + SPACE + '/views').then((value) => {
    if (value == null) return;
    counts.views = value;
    show(viewStat, viewNum, viewWord, value, 'view', 'views');
    remember();
  });

  const users = seen ? ask('/get/' + SPACE + '/users') : ask('/hit/' + SPACE + '/users');
  users.then((value) => {
    if (value == null) return;
    counts.users = value;
    if (!seen) write(SEEN, '1');
    show(userStat, userNum, userWord, value, 'user', 'users');
    remember();
  });
})();
