# Reddit Scout

Finds Reddit posts from people asking for help with a CRM, HR software or AI
automation, then has Claude judge each one and draft the reply. It runs on
this Mac, in a real Chrome window, on your Claude subscription (the `claude`
CLI). Nothing is posted until you click Post on a draft you have read.

## Run it

```sh
cd tools/reddit-scout
npm install
npm run login    # once: sign in to Reddit in the window that opens
npm start        # about 10 minutes, once a day; opens the report when done
npm run review   # the same report with Post buttons, on http://127.0.0.1:4777
```

On the review page, edit a draft until it sounds like you, then click
**Post to Reddit** twice. The scout's Chrome window opens the thread, posts
that exact text as you, waits for Reddit to show it and links to it. Posts are
spaced at least 90 seconds apart. If Reddit refuses ("you are doing that too
much…", locked thread), its message is shown and nothing is retried. DMs are
never sent by the scout: **Open message** opens Reddit's compose page with
the draft filled in, and you press send.

Posted comments are watched on later runs: when OP answers you, the next run
drafts your reply under their answer; after 3 days of silence it drafts one
follow-up under your comment, and after that it stops.

Chrome 136+ will not let a script drive your everyday profile, so the scout
has its own profile in `~/.reddit-scout/chrome-profile`. You sign in once.
Your normal Chrome is not touched.

## What a run does

1. Runs each search in `config.js` on www.reddit.com, newest first, past week,
   pausing 8–15 s between pages. old.reddit.com now redirects to the main site.
2. Drops posts it has already judged, freelancers' "[For Hire]" ads,
   AutoModerator and anything older than 4 days. Claude screens the titles,
   then up to 15 threads are opened to read the post, top comments and whether
   OP is answering people.
3. Re-reads threads it marked worth pursuing in the last 10 days. If you
   commented and OP replied to you, that goes back to Claude for a reply. If
   you commented 3+ days ago with no answer, it suggests the one follow-up.
4. Sends the threads to `claude -p` in batches of 8, which returns a verdict
   (pursue, maybe or skip), who is asking, budget, competition, the next
   action and drafts that follow Reddit etiquette.
5. Writes `out/<date_time>/report.html` and opens it. The links open Reddit
   in your normal browser.

If Reddit shows a CAPTCHA or a block page, or two pages in a row fail, the run
stops there and reports what it already had. It does not try to get past them.
Reddit refused the account after about 120 page loads in half an hour, so run
this once a day and keep `config.js` near 40 pages a run.

## Commands

| Command | Does |
| --- | --- |
| `npm start` | browse, judge, open the report |
| `npm run scout` | browse only, no Claude |
| `npm run analyze` | judge what the last run collected but did not judge |
| `npm run review` | serve the latest report with Post buttons |
| `npm run post -- t3_abc` | show the draft for one thread; add `--yes` to post it |
| `npm test` | unit tests (uses headless Chrome, no network) |

`SCOUT_MODEL=sonnet npm start` uses less of the subscription than the
default `opus`.

## Files

- `config.js`: the searches, limits and pacing. Edit the searches here.
- `extract.js`: everything that knows Reddit's HTML. If Reddit changes its
  markup, the run saves `debug-search.html` / `debug-thread.html` in its
  `out/` folder so the selectors can be fixed against a real page.
- `analyze.js`: the prompt, what DevEntia sells, the excluded trades (read
  from `backend/lib/qualify/excludedCategories.js`) and the output schema.
- `~/.reddit-scout/state.json`: posts already judged, and the threads being
  watched for replies.
