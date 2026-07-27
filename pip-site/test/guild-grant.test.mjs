/**
 * Tests for the server-plan grant path (2026-07-27).
 *
 * Before this, checkout only ever collected a Discord/Telegram handle, so a
 * Server Pro purchase wrote the plan onto the BUYER's beta_testers row and the
 * server itself stayed on trial caps — guardrails.ts reads server plans from
 * guilds.server_tier, which nothing populated. Every server plan had to be
 * applied by hand in SQL.
 *
 * These assert the shape of what we write, not just that we wrote something:
 * the guilds upsert must never carry created_at (the free-trial window is
 * derived from it, so resending it on an existing guild resets their trial) or
 * a null name (it would wipe the name the bot recorded).
 *
 * Run: node pip-site/test/guild-grant.test.mjs
 */
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';

const { isServerPlan, guildKeyFor, applyGrant } = await import('../api/_lib.js');

let pass = 0;
const fails = [];
function check(name, cond) {
  if (cond) pass++;
  else fails.push(name);
}
function eq(name, got, want) {
  check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);
}

// ---- plan classification ----------------------------------------------------
eq('server-pro is a server plan', isServerPlan('server-pro'), true);
eq('personal-pro is not', isServerPlan('personal-pro'), false);
eq('personal-lite is not', isServerPlan('personal-lite'), false);
eq('null is not', isServerPlan(null), false);

// ---- guild key normalization ------------------------------------------------
eq('discord snowflake passes through', guildKeyFor('discord', '1053808073157906542'), '1053808073157906542');
eq('discord id is trimmed', guildKeyFor('discord', '  1053808073157906542 '), '1053808073157906542');
eq('discord rejects short input', guildKeyFor('discord', '12345'), null);
eq('discord rejects an invite url', guildKeyFor('discord', 'discord.gg/zUvpPaYdAu'), null);
eq('discord rejects a server NAME', guildKeyFor('discord', 'SaveTheWhal3s'), null);
eq('empty is null', guildKeyFor('discord', ''), null);
eq('undefined is null', guildKeyFor('discord', undefined), null);
// Telegram chats are namespaced `tg:` so their ids can't collide with snowflakes.
eq('telegram group gets the tg: prefix', guildKeyFor('telegram', '-1001234567890'), 'tg:-1001234567890');
eq('telegram tolerates a pasted tg: prefix', guildKeyFor('telegram', 'tg:-1001234567890'), 'tg:-1001234567890');
eq('telegram rejects a @groupname', guildKeyFor('telegram', '@pipgroup'), null);
// A Discord id typed under the Telegram tab is still a number — it must not be
// silently accepted as a bare snowflake; it becomes a tg: key, which is right,
// because the buyer picked Telegram.
eq('telegram wraps a positive id too', guildKeyFor('telegram', '1053808073157906542'), 'tg:1053808073157906542');

// ---- applyGrant writes ------------------------------------------------------
function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, text: async () => '' };
  };
  return calls;
}
const table = (calls, name) => calls.filter((c) => c.url.includes(`/rest/v1/${name}`));

{
  const calls = stubFetch();
  const out = await applyGrant({
    platform: 'discord', handle: 'someone', plan: 'personal-lite', billing: 'monthly',
    provider: 'moonpay', subscriptionId: 'sub_1', guildId: null,
  });
  eq('personal: one beta_testers write', table(calls, 'beta_testers').length, 1);
  eq('personal: no guilds write', table(calls, 'guilds').length, 0);
  eq('personal: no guild returned', out.guildId, null);
  eq('personal: keyed by @handle', table(calls, 'beta_testers')[0].body.platform_id, '@someone');
}

{
  const calls = stubFetch();
  const out = await applyGrant({
    platform: 'discord', handle: 'admin', plan: 'server-pro', billing: 'yearly',
    provider: 'dodo', subscriptionId: 'sub_2', guildId: '956446038598750238',
  });
  const g = table(calls, 'guilds')[0];
  eq('server: buyer row still written', table(calls, 'beta_testers').length, 1);
  eq('server: guild row written', table(calls, 'guilds').length, 1);
  eq('server: guild id returned', out.guildId, '956446038598750238');
  eq('server: guild keyed by id', g.body.id, '956446038598750238');
  eq('server: tier on the guild', g.body.server_tier, 'server-pro');
  eq('server: provider recorded', g.body.server_subscription_provider, 'dodo');
  check('server: guild access window is set', typeof g.body.server_access_until === 'string');
  // Yearly = 368d of access (32d grace on top of the billing period).
  const days = (new Date(g.body.server_access_until) - Date.now()) / 86_400_000;
  check(`server: yearly window ~368d (got ${days.toFixed(1)})`, days > 360 && days < 370);
  // The two fields that must never be in this payload.
  check('server: no created_at (would reset their trial window)', !('created_at' in g.body));
  check('server: no name (would wipe the bot-recorded name)', !('name' in g.body));
  // The buyer's own row carries the server tier for the console's MRR / active
  // subs. personalPlan() in guardrails.ts ignores server-* tiers, so this does
  // NOT hand the buyer a personal plan.
  eq('server: buyer row records the tier', table(calls, 'beta_testers')[0].body.tier, 'server-pro');
}

{
  const calls = stubFetch();
  const out = await applyGrant({
    platform: 'discord', handle: 'admin', plan: 'server-pro', billing: 'monthly',
    provider: 'moonpay', subscriptionId: 'sub_3', guildId: 'not-an-id',
  });
  eq('bad guild id: flagged unmapped', out.guildUnmapped, true);
  eq('bad guild id: no guilds write', table(calls, 'guilds').length, 0);
  // Never lose the sale just because the server can't be resolved.
  eq('bad guild id: buyer still granted', table(calls, 'beta_testers').length, 1);
}

{
  const calls = stubFetch();
  const out = await applyGrant({
    platform: 'telegram', handle: 'admin', plan: 'server-pro', billing: 'monthly',
    provider: 'loop', subscriptionId: 'sub_4', guildId: '-1001234567890',
  });
  eq('telegram: guild written under the tg: key', table(calls, 'guilds')[0].body.id, 'tg:-1001234567890');
  eq('telegram: returned key matches', out.guildId, 'tg:-1001234567890');
}

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
