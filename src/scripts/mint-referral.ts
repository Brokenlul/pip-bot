/*
 * One-off: mint (or fetch) a referral code + link for a specific user,
 * reusing the actual production minting function so the code always matches
 * what referral_link's tool would generate.
 *
 *   npx tsx src/scripts/mint-referral.ts <discord|telegram> <userId>
 */
import { getOrMintReferralCode } from '../memory/referral.js';
import { getConfig } from '../config.js';

async function main(): Promise<void> {
  const [platform, userId] = process.argv.slice(2);
  if ((platform !== 'discord' && platform !== 'telegram') || !userId) {
    console.error('usage: mint-referral.ts <discord|telegram> <userId>');
    process.exit(1);
  }
  const code = await getOrMintReferralCode(platform, userId);
  if (!code) {
    console.error('could not mint a code — does this user have a beta_testers row?');
    process.exit(1);
  }
  const base = (getConfig().PIP_SITE_BASE_URL || 'https://pipinvest.xyz').replace(/\/+$/, '');
  console.log(`code: ${code}`);
  console.log(`link: ${base}/r/${code}`);
}

main().catch((e) => {
  console.error(`failed: ${(e as Error).message}`);
  process.exit(1);
});
