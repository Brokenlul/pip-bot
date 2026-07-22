/*
 * pip first-party analytics. Loaded on every page as <script defer src="/assets/track.js">.
 * Posts to /api/track, which writes to public.site_events.
 *
 * No cookies, no third party, no fingerprinting. The visitor id is a random
 * string in localStorage and is the only thing that persists; clearing site
 * data resets it completely. Honours Do Not Track.
 */
(function () {
  'use strict';

  // Respect DNT. Costs us some coverage, but it's the honest default for
  // analytics we run ourselves. Flip this line if you'd rather count everyone.
  var dnt = navigator.doNotTrack || window.doNotTrack;
  if (dnt === '1' || dnt === 'yes') return;

  var VISITOR_KEY = 'pip_vid';
  var SESSION_KEY = 'pip_sid';
  var SESSION_AT = 'pip_sid_at';
  var ATTR_KEY = 'pip_attr';
  var SESSION_IDLE_MS = 30 * 60 * 1000;

  function rand() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // localStorage throws in Safari private mode and when storage is blocked;
  // fall back to a per-pageview id rather than losing the event entirely.
  function store(key, make) {
    try {
      var v = localStorage.getItem(key);
      if (!v) { v = make(); localStorage.setItem(key, v); }
      return v;
    } catch (e) { return make(); }
  }

  var visitorId = store(VISITOR_KEY, rand);

  // Session = same visitor, under 30 min since their last event.
  var sessionId;
  try {
    var last = Number(localStorage.getItem(SESSION_AT) || 0);
    sessionId = localStorage.getItem(SESSION_KEY);
    if (!sessionId || !last || Date.now() - last > SESSION_IDLE_MS) {
      sessionId = rand();
      localStorage.setItem(SESSION_KEY, sessionId);
    }
    localStorage.setItem(SESSION_AT, String(Date.now()));
  } catch (e) { sessionId = rand(); }

  // ---- attribution ---------------------------------------------------------
  // First touch wins: whatever brought someone in is remembered for later
  // events, so a click on day 3 is still credited to the tweet that landed them.
  var q = new URLSearchParams(location.search);
  var attr = { source: q.get('utm_source'), medium: q.get('utm_medium'), campaign: q.get('utm_campaign') };
  try {
    if (attr.source || attr.medium || attr.campaign) {
      localStorage.setItem(ATTR_KEY, JSON.stringify(attr));
    } else {
      var saved = localStorage.getItem(ATTR_KEY);
      if (saved) attr = JSON.parse(saved);
    }
  } catch (e) { /* storage blocked: this pageview is unattributed, fine */ }

  var isMobile = matchMedia('(max-width: 720px)').matches;

  function send(event, target, meta) {
    var body = JSON.stringify({
      event: event,
      visitorId: visitorId,
      sessionId: sessionId,
      path: location.pathname,
      target: target || null,
      referrer: document.referrer || null,
      utmSource: attr.source || null,
      utmMedium: attr.medium || null,
      utmCampaign: attr.campaign || null,
      device: isMobile ? 'mobile' : 'desktop',
      meta: meta || {},
    });
    try {
      // sendBeacon survives the page unloading, which a plain fetch does not —
      // that matters because most of our events ARE outbound navigations.
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([body], { type: 'application/json' }));
        return;
      }
      fetch('/api/track', { method: 'POST', body: body, headers: { 'content-type': 'application/json' }, keepalive: true });
    } catch (e) { /* never let analytics break the page */ }
  }

  send('pageview');

  // ---- CTA clicks ----------------------------------------------------------
  // Destination host/path -> the funnel step it represents. Matching on the
  // link itself (not on ids) means dynamically rendered pricing cards and any
  // CTA added later are instrumented automatically, with no extra markup.
  function nameFor(href) {
    if (href.indexOf('discord.com/oauth2/authorize') > -1) return 'discord_add_bot';
    if (href.indexOf('discord.gg') > -1) return 'discord_community';
    if (href.indexOf('t.me/') > -1) return 'telegram_bot';
    if (href.indexOf('x.com') > -1 || href.indexOf('twitter.com') > -1) return 'twitter';
    if (href.indexOf('checkout.dodopayments.com') > -1) return 'dodo_checkout';
    return null;
  }

  // ---- attribution handoff -------------------------------------------------
  // A CTA click is where we lose people today: they leave for Discord/Telegram
  // and arrive as a platform id with nothing tying them back to this visitor.
  // Stamp a one-time token onto the handoff and the other side can claim it.
  //
  // The community invite (discord.gg/...) is deliberately absent: an invite
  // link accepts no per-visitor parameter, so that path stays cohort-only.
  var DISCORD_REDIRECT = 'https://pipinvest.xyz/api/discord-installed';

  // Discord rejects an authorize link whose redirect_uri is not registered on
  // the application, and it does so BEFORE the user sees the install screen —
  // so shipping this ahead of the dev-portal change would kill the add-bot CTA
  // outright. Flip to true only once DISCORD_REDIRECT is listed under
  // OAuth2 → Redirects for application 1521437096294744216.
  // Telegram attribution below needs no such registration and is always on.
  var ADD_BOT_ATTRIBUTION = false;

  function attribute(el, href, name) {
    // Always rebuild from the pristine href, so a second click on the same
    // element doesn't stack a second set of query parameters onto the first.
    var base = el.getAttribute('data-attr-base');
    if (!base) { base = href; el.setAttribute('data-attr-base', base); }

    var token = rand().replace(/-/g, '').slice(0, 32);

    if (name === 'telegram_bot') {
      // Deep link: the payload arrives as the text of their /start message.
      // Telegram caps it at 64 chars of [A-Za-z0-9_-] — 32 hex fits fine.
      el.setAttribute('href', base.split('?')[0] + '?start=' + token);
      return token;
    }
    if (name === 'discord_add_bot' && ADD_BOT_ATTRIBUTION) {
      // response_type=code is required whenever redirect_uri is supplied, even
      // for a bot-only install. Discord hands back ?code&state&guild_id, and
      // guild_id is the part we actually want — we never exchange the code.
      el.setAttribute('href', base +
        '&response_type=code' +
        '&redirect_uri=' + encodeURIComponent(DISCORD_REDIRECT) +
        '&state=' + token);
      return token;
    }
    return null;
  }

  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('a[href], button[id]') : null;
    if (!el) return;

    // Explicit override always wins: add data-ev="name" to label anything.
    var explicit = el.getAttribute('data-ev');
    if (explicit) { send('click', explicit); return; }

    if (el.tagName === 'BUTTON') {
      // The two payment buttons in the checkout modal are the deepest
      // measurable step before the visitor leaves for the provider.
      if (el.id === 'checkout-card') send('checkout_submit', 'card');
      else if (el.id === 'checkout-usdc') send('checkout_submit', 'crypto');
      return;
    }

    var href = el.getAttribute('href') || '';

    // A pricing CTA opens the checkout modal (or the free-trial modal) rather
    // than navigating. renderPricing stamps the slug onto the CTA for us.
    var evPlan = el.getAttribute('data-ev-plan');
    if (evPlan) {
      send('checkout_start', evPlan, { billing: el.getAttribute('data-ev-billing') || '' });
      return;
    }

    var name = nameFor(href);
    if (name) {
      var token = attribute(el, href, name);
      send('click', name, token ? { token: token } : null);
    }
  }, true);
})();
