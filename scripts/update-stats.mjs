// Builds the stats card on the GitHub profile (assets/stats-dark.svg and assets/stats-light.svg).
// Runs daily from .github/workflows/update-stats.yml. Only counts are written, never repo names.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const TOKEN = process.env.STATS_TOKEN;
const LOGIN = process.env.GH_LOGIN || "kmander";
const ORG = process.env.STATS_ORG || "YucaApp";
const OUT_DIR = process.env.OUT_DIR || "assets";
const MOCK = process.env.MOCK_DATA; // path to a JSON fixture, for local testing only

// ---------- GitHub API ----------

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub API error: ${JSON.stringify(json.errors || json)}`);
  return json.data;
}

// Commits per calendar year, private ones included.
async function fetchYearlyCommits(createdAt, now) {
  const years = [];
  for (let y = new Date(createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    const d = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from, to: $to) { totalCommitContributions restrictedContributionsCount }
        }
      }`,
      { login: LOGIN, from: `${y}-01-01T00:00:00Z`, to }
    );
    const c = d.user.contributionsCollection;
    years.push({ year: y, commits: c.totalCommitContributions + c.restrictedContributionsCount });
  }
  return years;
}

async function fetchUser() {
  const { user } = await gql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        contributionsCollection {
          contributionCalendar { weeks { contributionDays { date contributionCount } } }
        }
      }
    }`,
    { login: LOGIN }
  );
  return user;
}

// Every repo in the org, plus the ones on the personal account.
async function fetchRepos() {
  const repos = [];
  for (const [owner, field] of [[ORG, "organization"], [LOGIN, "user"]]) {
    let after = null;
    do {
      const data = await gql(
        `query($owner: String!, $after: String) {
          ${field}(login: $owner) {
            repositories(first: 100, after: $after, ownerAffiliations: OWNER) {
              pageInfo { hasNextPage endCursor }
              nodes { isPrivate }
            }
          }
        }`,
        { owner, after }
      );
      const page = data[field].repositories;
      repos.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
  }
  return repos;
}

async function loadData(now) {
  if (MOCK) return JSON.parse(await readFile(MOCK, "utf8"));
  if (!TOKEN) {
    console.error("STATS_TOKEN is not set. Add it under Settings > Secrets and variables > Actions.");
    process.exit(1);
  }
  const user = await fetchUser();
  const [yearly, repos] = await Promise.all([fetchYearlyCommits(user.createdAt, now), fetchRepos()]);
  const daily = user.contributionsCollection.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }));
  return { yearly, daily, repos };
}

// ---------- Numbers ----------

const fmt = (n) => Math.round(n).toLocaleString("en-GB");

function insights({ yearly, daily, repos }, now) {
  // Skip empty years before the first commit.
  const first = yearly.findIndex((y) => y.commits > 0);
  const years = first === -1 ? yearly : yearly.slice(first);
  const total = years.reduce((a, y) => a + y.commits, 0);

  // The year things took off: first year with 500+ commits and at least double the best year before it.
  let boom = null;
  let bestSoFar = 0;
  for (const y of years) {
    if (y.commits >= 500 && y.commits >= bestSoFar * 2) {
      boom = y.year;
      break;
    }
    bestSoFar = Math.max(bestSoFar, y.commits);
  }

  // Current streak; nothing yet today doesn't break it.
  const days = daily.filter((d) => d.date <= now.toISOString().slice(0, 10));
  let streak = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  for (; i >= 0 && days[i].count > 0; i--) streak++;

  return {
    years,
    total,
    boom,
    streak,
    thisYear: now.getUTCFullYear(),
    priv: repos.filter((r) => r.isPrivate).length,
    pub: repos.filter((r) => !r.isPrivate).length,
  };
}

// ---------- SVG ----------

const THEMES = {
  dark: {
    bg: "#0d1117",
    border: "#30363d",
    text: "#f0f6fc",
    muted: "#9198a1",
    quiet: "#3a3f4b",
    tiles: ["#2a1f3d", "#3a2418", "#16283a", "#16302a"],
    hotA: "#ff5f8f",
    hotB: "#ffb547",
  },
  light: {
    bg: "#ffffff",
    border: "#d1d9e0",
    text: "#1f2328",
    muted: "#59636e",
    quiet: "#d9dce3",
    tiles: ["#f3ecff", "#fff1e6", "#e8f3ff", "#e6f7ef"],
    hotA: "#f43f74",
    hotB: "#ff9f1c",
  },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderSvg(ins, theme) {
  const t = THEMES[theme];
  const W = 880;
  const H = 470;
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif">`,
    `<defs><linearGradient id="hot" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${t.hotA}"/><stop offset="1" stop-color="${t.hotB}"/></linearGradient></defs>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="20" fill="${t.bg}" stroke="${t.border}"/>`
  );

  // Tiles
  const tiles = [
    { emoji: "📤", big: fmt(ins.total), label: "commits" },
    { emoji: "🔥", big: fmt(ins.streak), label: "day streak" },
    { emoji: "🔒", big: fmt(ins.priv), label: "private repos" },
    { emoji: "🌍", big: fmt(ins.pub), label: "public repos" },
  ];
  const gap = 14;
  const tw = (W - 64 - gap * 3) / 4;
  tiles.forEach((tile, i) => {
    const x = 32 + i * (tw + gap);
    out.push(
      `<rect x="${x}" y="28" width="${tw}" height="126" rx="16" fill="${t.tiles[i]}"/>`,
      `<text x="${x + 18}" y="72" font-size="34">${tile.emoji}</text>`,
      `<text x="${x + 20}" y="118" font-size="38" font-weight="800" fill="${t.text}">${esc(tile.big)}</text>`,
      `<text x="${x + 20}" y="141" font-size="15" fill="${t.muted}">${esc(tile.label)}</text>`
    );
  });

  // Chart: one chunky bar per year
  const cx = 32;
  const cw = W - 64;
  const base = 410;
  const top = 210;
  const ch = base - top;
  const n = ins.years.length;
  const slot = cw / n;
  const bw = Math.min(40, slot * 0.66);
  const max = Math.max(1, ...ins.years.map((y) => y.commits));
  const boomIdx = ins.years.findIndex((y) => y.year === ins.boom);
  const barH = (c) => Math.max(6, (c / max) * ch);

  out.push(`<text x="${cx}" y="190" font-size="15" font-weight="600" fill="${t.muted}">Commits per year</text>`);

  ins.years.forEach((y, i) => {
    const hot = boomIdx !== -1 && i >= boomIdx;
    const h = barH(y.commits);
    const x = cx + i * slot + (slot - bw) / 2;
    out.push(
      `<rect x="${x.toFixed(1)}" y="${(base - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(10, bw / 2, h / 2).toFixed(1)}" fill="${hot ? "url(#hot)" : t.quiet}"/>`,
      `<text x="${(x + bw / 2).toFixed(1)}" y="${base + 24}" font-size="13.5" text-anchor="middle" fill="${t.muted}">${hot ? y.year : `'${String(y.year).slice(2)}`}</text>`
    );
    if (!hot) {
      out.push(
        `<text x="${(x + bw / 2).toFixed(1)}" y="${(base - h - 7).toFixed(1)}" font-size="13" text-anchor="middle" fill="${t.muted}">${fmt(y.commits)}</text>`
      );
    }
  });

  if (boomIdx > 0) {
    // Snoozing over the quiet years
    const quietEnd = cx + boomIdx * slot;
    out.push(
      `<text x="${((cx + quietEnd) / 2).toFixed(1)}" y="${(base - ch * 0.42).toFixed(1)}" font-size="22" text-anchor="middle" fill="${t.muted}">💤 <tspan font-style="italic">zzz</tspan></text>`
    );
    // The big moment
    const b = ins.years[boomIdx];
    const bx = cx + boomIdx * slot + slot / 2;
    const by = base - barH(b.commits);
    const lx = bx - 150;
    const ly = by + 34;
    const left = bx - bw / 2;
    out.push(
      `<text x="${lx}" y="${ly}" font-size="18" font-weight="700" text-anchor="end" fill="${t.text}">🤖 met my clanker</text>`,
      `<text x="${lx}" y="${ly + 22}" font-size="14" text-anchor="end" fill="${t.muted}">${fmt(b.commits)} commits in ${b.year}${b.year === ins.thisYear ? " so far" : ""}</text>`,
      `<path d="M${lx + 10} ${ly - 8} Q ${bx - 70} ${by - 14} ${left - 10} ${by + 6}" fill="none" stroke="${t.muted}" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 6"/>`,
      `<path d="M${left - 20} ${by - 1} L ${left - 9} ${by + 6} L ${left - 18} ${by + 15}" fill="none" stroke="${t.muted}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
    );
  }

  out.push(`</svg>`);
  return out.join("\n");
}

// ---------- Main ----------

async function main() {
  const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
  const ins = insights(await loadData(now), now);
  await mkdir(OUT_DIR, { recursive: true });
  for (const theme of Object.keys(THEMES)) {
    await writeFile(`${OUT_DIR}/stats-${theme}.svg`, renderSvg(ins, theme));
  }
  console.log(`Done: ${fmt(ins.total)} commits, ${ins.streak}-day streak, ${ins.priv} private / ${ins.pub} public repos.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
