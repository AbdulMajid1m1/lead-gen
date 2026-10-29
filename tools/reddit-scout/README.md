# Reddit Scout

Finds Reddit posts from people asking for help with a CRM, HR software or AI
automation, then has Claude judge each one and draft the reply. It runs on
this Mac, in a real Chrome window, on your Claude subscription (the `claude`
CLI). It never posts anything: you read the thread, edit the draft and post
it yourself.

## Run it

```sh
cd tools/reddit-scout
npm install
npm run login    # once: sign in to Reddit in the window that opens, then Cmd+Q
npm start        # about 10 minutes; opens the report when done
```

Chrome 136+ will not let a script drive your everyday profile, so the scout
has its own profile in `~/.reddit-scout/chrome-profile`. You sign in once.
Your normal Chrome is not touched.

## What a run does

1. Runs each search in `config.js` on old.reddit.com, newest first, past week
   (2 pages each), pausing 4–9 s between pages.
2. Drops posts it has already judged, freelancers' "[For Hire]" ads,
   AutoModerator and anything older than 7 days, then opens up to 40 threads
   and reads the post, top comments and whether OP is answering people.
3. Re-reads threads it marked worth pursuing in the last 10 days. If you
   commented and OP replied to you, that goes back to Claude for a reply. If
   you commented 3+ days ago with no answer, it suggests the one follow-up.
4. Sends the threads to `claude -p` in batches of 8, which returns a verdict
   (pursue, maybe or skip), who is asking, budget, competition, the next
   action and drafts that follow Reddit etiquette.
5. Writes `out/<date_time>/report.html` and opens it. The links open Reddit
   in your normal browser.

If Reddit shows a CAPTCHA, a block page or a 429, the run stops there and
reports what it already had. It does not try to get past them.

## Commands

| Command | Does |
| --- | --- |
| `npm start` | browse, judge, open the report |
| `npm run scout` | browse only, no Claude |
| `npm run analyze` | judge what the last run collected but did not judge |
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
