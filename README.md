# Gmail Sweeper

A Google Apps Script that automatically cleans up your Gmail inbox. It discovers who's flooding your inbox, lets you block them by domain, bulk-trashes junk, purges old promotions, and runs daily on autopilot.

No installs. No API keys. No third-party access. It runs entirely inside your own Google account.

---

## Why

Gmail's spam filter catches obvious junk, but promotional emails, newsletters you never subscribed to, and marketing blasts pile up in Promotions, Updates, and Social tabs. Manually unsubscribing from hundreds of senders isn't realistic. This script automates the entire process.

---

## How It Works

1. **Discover** — Scans your Promotions, Updates, Social, and Spam folders. Ranks every sender domain by email volume over the last 30 days. You see exactly who's flooding your inbox.

2. **Block** — You pick the domains you don't want. Add them to a block list stored in your Google account's Script Properties (not in the code, so it persists across updates).

3. **Clean** — Trashes all existing emails from blocked domains. Also purges promotional emails older than a configurable threshold (default: 7 days).

4. **Automate** — Sets up a daily trigger that runs cleanup at 3am. Your inbox stays clean without you lifting a finger.

---

## Safety Guarantees

| Guarantee | How |
|---|---|
| **Primary inbox is never touched** | All cleanup queries explicitly exclude `-category:primary`. Even if you accidentally block `gmail.com`, your Primary emails are safe. |
| **Trash, not permanent delete** | Everything uses `moveToTrash()`. Gmail keeps trashed emails for 30 days. You can recover anything. |
| **Discovery is read-only** | `discoverSpam()` scans and reports. It does not move, delete, or modify any email. |
| **You control the block list** | Only domains you explicitly add are affected. The script never makes blocking decisions on its own. |
| **Respects execution limits** | Long-running cleanups automatically stop before hitting Google's 6-minute limit. Run again to continue. |

---

## Setup (5 minutes)

### Step 1: Create the script

1. Go to [script.google.com](https://script.google.com)
2. Click **New project**
3. Delete the default `myFunction()` code
4. Copy the entire contents of [`src/cleanup.gs`](src/cleanup.gs) and paste it in
5. Save the project (give it any name, e.g., "Gmail Cleanup")

### Step 2: Initialize

1. In the function dropdown at the top, select **`configureDefaults`**
2. Click **Run**
3. Google will ask you to authorize Gmail access — click through the prompts
   - You'll see a "This app isn't verified" warning. Click **Advanced** > **Go to [project name] (unsafe)**. This is expected for personal scripts.
4. Check **View > Logs** — you should see the default settings confirmed

### Step 3: Discover your top spammers

1. Select **`discoverSpam`** from the dropdown
2. Click **Run** (this takes 1-2 minutes — it scans up to 800 threads)
3. Check **View > Logs** — you'll see output like:

```
=== TOP SENDERS (last 30 days) ===
81 emails — linkedin.com
28 emails — marketing.retailer.com
20 emails — newsletters.junksite.com
15 emails — promo.somestore.com
...
```

### Step 4: Build your block list

1. Review the sender list. Decide which domains you want to block.
2. In the script editor, scroll to the `addBlocks()` function at the bottom
3. Add your unwanted domains:

```javascript
function addBlocks() {
  updateBlockedDomains([
    'marketing.retailer.com',
    'newsletters.junksite.com',
    'promo.somestore.com',
  ]);
}
```

4. Select **`addBlocks`** from the dropdown and click **Run**
5. Check the logs — it will confirm how many domains were added

**Tips for choosing what to block:**
- Block gibberish domains (random strings, `.biz.ua`, `.org.uk` with numbers) — these are spam
- Block retail marketing subdomains (e.g., `bc.footlocker.com`, `emails.skechers.com`) — these are promotional
- **Don't block** domains you use for banking, utilities, school, work, or services you actively use
- When in doubt, leave it out — you can always add more later

### Step 5: Run the cleanup

1. Select **`bulkCleanup`** and click **Run**
2. Check the logs to see how many threads were trashed per domain
3. Check your Gmail Trash to verify the right emails landed there

### Step 6: Schedule daily auto-cleanup

1. Select **`installTrigger`** and click **Run**
2. The script will now run automatically at approximately 3am every day
3. It will purge old promotions and trash emails from your blocked domains

That's it. Your inbox is on autopilot.

---

## All Functions Reference

| Function | What it does | Safe to run? |
|---|---|---|
| `configureDefaults()` | Initializes Script Properties with default settings. Run once during setup. | Yes — only writes defaults if not already set |
| `discoverSpam()` | Scans Promotions, Updates, Social, and Spam. Ranks senders by volume. | Yes — read-only, changes nothing |
| `addBlocks()` | Adds domains you've listed to the block list. Edit the function first. | Yes — only saves to Script Properties |
| `updateBlockedDomains(domains)` | Programmatically adds domains to the block list. Pass a JS array. | Yes — only saves to Script Properties |
| `updateBlockedDomains()` | With no arguments, shows the current block list in the logs. | Yes — read-only |
| `unblockDomain(domain)` | Removes a single domain from the block list. | Yes — only modifies Script Properties |
| `bulkCleanup()` | Trashes emails from all blocked domains. Skips Primary inbox. | Moves to Trash (recoverable) |
| `purgeOldPromotions()` | Trashes promotional emails older than configured threshold. | Moves to Trash (recoverable) |
| `dailyAutoClean()` | Runs `purgeOldPromotions()` + `bulkCleanup()` together. | Moves to Trash (recoverable) |
| `installTrigger()` | Creates a daily trigger at 3am for `dailyAutoClean()`. | Yes — sets up automation |
| `removeTriggers()` | Removes all triggers created by this script. | Yes — stops automation |

---

## Configuration

All settings are stored in **Script Properties** (not hardcoded in the code), so they persist across script updates.

To view or change: **File > Project properties > Script properties** in the Apps Script editor, or use `configureDefaults()` to reset to defaults.

| Property | Default | What it controls |
|---|---|---|
| `BLOCK_DOMAINS` | `[]` | JSON array of blocked domain strings. Managed via `updateBlockedDomains()` and `unblockDomain()` — you don't need to edit this directly. |
| `PROMO_MAX_AGE_DAYS` | `7` | Promotional emails older than this many days are auto-trashed by `purgeOldPromotions()`. |
| `SCAN_WINDOW_DAYS` | `30` | How far back `discoverSpam()` looks when scanning your inbox. |

---

## FAQ

**Will this delete important emails?**
No. It explicitly skips your Primary inbox. It only touches Promotions, Updates, Social, and Spam categories. Everything goes to Trash, which Gmail keeps for 30 days.

**What if I block a domain by mistake?**
Run `unblockDomain('thedomain.com')` to remove it. Any trashed emails are recoverable from Gmail Trash for 30 days.

**Can I run cleanup manually instead of on a schedule?**
Yes. Just run `bulkCleanup()` or `purgeOldPromotions()` whenever you want. The trigger is optional.

**How do I add more domains later?**
Edit the `addBlocks()` function with new domains and run it again. Or call `updateBlockedDomains(['newdomain.com'])` directly. It merges with your existing list — no duplicates.

**How do I see what's currently blocked?**
Run `updateBlockedDomains()` with no arguments. Check the logs.

**Does this work with Google Workspace (business Gmail)?**
Yes, as long as your Workspace admin allows Google Apps Script and Gmail access.

**The script times out on large inboxes. What do I do?**
Just run it again. It automatically picks up where it left off because it only processes emails that haven't been trashed yet. Each run handles up to 5 minutes of cleanup.

---

## Uninstall

1. Run `removeTriggers()` to stop the daily schedule
2. Delete the project from [script.google.com](https://script.google.com)
3. Revoke access: [Google Account > Security > Third-party apps](https://myaccount.google.com/permissions)

---

## License

MIT License. See [LICENSE](LICENSE) for details.

---

Built in collaboration with [Claude Code](https://claude.ai/code) by Anthropic.
