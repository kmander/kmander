// Builds the stats card shown on the GitHub profile (assets/stats-dark.svg and assets/stats-light.svg).
// Runs daily from .github/workflows/update-stats.yml.
// Only counts are written. Private repo names never leave this script.

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
  if (!res.ok || json.errors) {
    throw new Error(`GitHub API error: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

const pad = (n) => String(n).padStart(2, "0");

async function fetchMonthlyCommits(createdAt, now) {
  const firstYear = new Date(createdAt).getUTCFullYear();
  const lastYear = now.getUTCFullYear();
  const monthly = [];
  for (let y = firstYear; y <= lastYear; y++) {
    const parts = [];
    const keys = [];
    for (let m = 1; m <= 12; m++) {
      const from = new Date(Date.UTC(y, m - 1, 1));
      if (from > now) break;
      let to = new Date(Date.UTC(y, m, 1) - 1000);
      if (to > now) to = now;
      keys.push(`${y}-${pad(m)}`);
      parts.push(
        `m${m}: contributionsCollection(from: "${from.toISOString()}", to: "${to.toISOString()}") { totalCommitContributions restrictedContributionsCount }`
      );
    }
    const data = await gql(`query($login: String!) { user(login: $login) { ${parts.join("\n")} } }`, {
      login: LOGIN,
    });
    keys.forEach((month, i) => {
      const c = data.user[`m${i + 1}`];
      monthly.push({ month, commits: c.totalCommitContributions + c.restrictedContributionsCount });
    });
  }
  return monthly;
}

async function fetchUser() {
  const { user } = await gql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        contributionsCollection {
          totalRepositoriesWithContributedCommits
          contributionCalendar { weeks { contributionDays { date contributionCount } } }
        }
      }
    }`,
    { login: LOGIN }
  );
  return user;
}

async function fetchOrgRepos() {
  const repos = [];
  let after = null;
  do {
    const data = await gql(
      `query($org: String!, $after: String) {
        organization(login: $org) {
          repositories(first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { isPrivate isArchived pushedAt }
          }
        }
      }`,
      { org: ORG, after }
    );
    const page = data.organization.repositories;
    repos.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return repos;
}

async function loadData(now) {
  if (MOCK) return JSON.parse(await readFile(MOCK, "utf8"));
  if (!TOKEN) {
    console.error("STATS_TOKEN is not set. Add it under Settings > Secrets and variables > Actions.");
    process.exit(1);
  }
  const user = await fetchUser();
  const [monthly, repos] = await Promise.all([fetchMonthlyCommits(user.createdAt, now), fetchOrgRepos()]);
  const daily = user.contributionsCollection.contributionCalendar.weeks
    .flatMap((w) => w.contributionDays)
    .map((d) => ({ date: d.date, count: d.contributionCount }));
  return {
    monthly,
    daily,
    repos,
    reposCommittedTo: user.contributionsCollection.totalRepositoriesWithContributedCommits,
  };
}

// ---------- Insights ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const fmt = (n) => Math.round(n).toLocaleString("en-GB");
const monthLabel = (key) => `${MONTHS[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;

function insights(data, now) {
  const { monthly, daily, repos } = data;

  // Rolling 12 months = this month plus the 11 before it.
  const recent = monthly.slice(-12);
  const before = monthly.slice(0, -12);
  const last12 = recent.reduce((a, m) => a + m.commits, 0);
  const prior = before.reduce((a, m) => a + m.commits, 0);
  const firstActive = monthly.find((m) => m.commits > 0) || monthly[0];
  const priorFrom = Number(firstActive.month.slice(0, 4));
  const priorTo = before.length ? Number(before[before.length - 1].month.slice(0, 4)) : priorFrom;
  const priorYears = Math.max(1, priorTo - priorFrom + 1);
  const best = monthly.reduce((a, m) => (m.commits > a.commits ? m : a), monthly[0]);

  // Streaks from the daily calendar (last 12 months).
  const days = daily.filter((d) => d.date <= now.toISOString().slice(0, 10));
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--; // today not started yet doesn't break the streak
  for (; i >= 0 && days[i].count > 0; i--) current++;

  const byWeekday = [0, 0, 0, 0, 0, 0, 0];
  for (const d of days) byWeekday[new Date(`${d.date}T00:00:00Z`).getUTCDay()] += d.count;
  const busiestDay = DAYS[byWeekday.indexOf(Math.max(...byWeekday))];

  const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
  const repoStats = {
    total: repos.length,
    private: repos.filter((r) => r.isPrivate).length,
    public: repos.filter((r) => !r.isPrivate).length,
    active30: repos.filter((r) => r.pushedAt && r.pushedAt >= cutoff).length,
  };

  return {
    last12,
    prior,
    priorFrom,
    priorTo,
    priorYears,
    multiple: prior ? last12 / prior : null,
    best,
    current,
    longest,
    busiestDay,
    repoStats,
    reposCommittedTo: data.reposCommittedTo,
  };
}

// ---------- SVG ----------

const THEMES = {
  dark: {
    bg: "#0d1117",
    border: "#30363d",
    tile: "#161b22",
    text: "#f0f6fc",
    muted: "#9198a1",
    faint: "#3d444d",
    old: "#4b535d",
    accentA: "#ff7a45",
    accentB: "#ffc53d",
  },
  light: {
    bg: "#ffffff",
    border: "#d1d9e0",
    tile: "#f6f8fa",
    text: "#1f2328",
    muted: "#59636e",
    faint: "#d1d9e0",
    old: "#b7bfc8",
    accentA: "#f0592b",
    accentB: "#f5a524",
  },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderSvg(data, ins, theme, now) {
  const t = THEMES[theme];
  const W = 880;
  const H = 492;
  const font = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif"`;
  const out = [];

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${font}>`,
    `<defs><linearGradient id="hot" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${t.accentA}"/><stop offset="1" stop-color="${t.accentB}"/></linearGradient></defs>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="${t.bg}" stroke="${t.border}"/>`
  );

  // Headline
  out.push(
    `<text x="32" y="50" font-size="24" font-weight="700" fill="${t.text}">Years of almost nothing. Then vibe coding.</text>`,
    `<text x="32" y="74" font-size="13" fill="${t.muted}">Commits per month since ${ins.priorFrom}, across public and private repos. I don't write the code, AI does. I just keep shipping.</text>`
  );

  // Stat tiles
  const tiles = [
    { big: fmt(ins.last12), label: "commits in the last 12 months", hot: true },
    {
      big: ins.multiple ? `${ins.multiple >= 10 ? fmt(ins.multiple) : ins.multiple.toFixed(1)}×` : "∞",
      label: `my previous ${ins.priorYears} years combined`,
    },
    {
      big: `${ins.current} days`,
      label: ins.current > 0 && ins.current >= ins.longest ? "streak, longest yet, still going" : `current streak (best: ${ins.longest})`,
    },
    {
      big: fmt(ins.repoStats.total),
      suffix: `${ORG} repos`,
      label: `${fmt(ins.repoStats.private)} private · ${fmt(ins.repoStats.public)} public`,
    },
  ];
  const tileY = 96;
  const tileH = 78;
  const gap = 12;
  const tileW = (W - 64 - gap * (tiles.length - 1)) / tiles.length;
  tiles.forEach((tile, i) => {
    const x = 32 + i * (tileW + gap);
    out.push(
      `<rect x="${x}" y="${tileY}" width="${tileW}" height="${tileH}" rx="10" fill="${t.tile}" stroke="${t.border}"/>`,
      `<text x="${x + 16}" y="${tileY + 40}" font-size="28" font-weight="700" fill="${tile.hot ? "url(#hot)" : t.text}">${esc(tile.big)}${tile.suffix ? `<tspan dx="6" font-size="14" font-weight="500" fill="${t.muted}">${esc(tile.suffix)}</tspan>` : ""}</text>`,
      `<text x="${x + 16}" y="${tileY + 62}" font-size="11.5" fill="${t.muted}">${esc(tile.label)}</text>`
    );
  });

  // Chart
  const cx = 32;
  const cw = W - 64;
  const top = 226;
  const base = 410;
  const ch = base - top;
  const n = data.monthly.length;
  const slot = cw / n;
  const barW = Math.max(1.5, slot * 0.72);
  const max = Math.max(1, ...data.monthly.map((m) => m.commits));
  const recentStart = n - 12;

  out.push(`<line x1="${cx}" y1="${base + 0.5}" x2="${cx + cw}" y2="${base + 0.5}" stroke="${t.faint}"/>`);

  data.monthly.forEach((m, i) => {
    if (!m.commits) return;
    const h = Math.max(2, (m.commits / max) * ch);
    const x = cx + i * slot + (slot - barW) / 2;
    const fill = i >= recentStart ? "url(#hot)" : t.old;
    out.push(`<rect x="${x.toFixed(2)}" y="${(base - h).toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" rx="1" fill="${fill}"/>`);
  });

  // Year labels every other year, plus the current one
  const years = [...new Set(data.monthly.map((m) => m.month.slice(0, 4)))];
  years.forEach((y, yi) => {
    const idx = data.monthly.findIndex((m) => m.month.startsWith(y));
    const isLast = yi === years.length - 1;
    if (yi % 2 !== 0 && !isLast) return;
    if (!isLast && yi === years.length - 2) return; // avoid crowding the final label
    const x = cx + idx * slot;
    out.push(`<text x="${x.toFixed(1)}" y="${base + 20}" font-size="11" fill="${t.muted}">${y}</text>`);
  });

  // Bracket over the quiet years
  const leftEnd = cx + recentStart * slot - 8;
  const bracketY = base - ch * 0.36;
  out.push(
    `<path d="M${cx} ${bracketY + 8} V${bracketY} H${leftEnd.toFixed(1)} V${bracketY + 8}" fill="none" stroke="${t.muted}" stroke-width="1" opacity="0.7"/>`,
    `<text x="${((cx + leftEnd) / 2).toFixed(1)}" y="${bracketY - 10}" font-size="12.5" text-anchor="middle" fill="${t.muted}">${ins.priorFrom}–${ins.priorTo}: ${fmt(ins.prior)} commits in ${ins.priorYears} years, all together</text>`
  );

  // Label the best month
  const bi = data.monthly.indexOf(ins.best);
  const bx = cx + bi * slot + slot / 2;
  const by = base - (ins.best.commits / max) * ch;
  out.push(
    `<text x="${(bx - 8).toFixed(1)}" y="${(by + 4).toFixed(1)}" font-size="12.5" font-weight="600" text-anchor="end" fill="${t.text}">${monthLabel(ins.best.month)}: ${fmt(ins.best.commits)} commits →</text>`
  );

  // Footer insight line
  const updated = now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const footer = [
    ins.reposCommittedTo != null ? `${fmt(ins.reposCommittedTo)} repos committed to in the last year` : null,
    `${fmt(ins.repoStats.active30)} ${ORG} repos pushed to in the last 30 days`,
    `busiest on ${ins.busiestDay}`,
    `updated ${updated}`,
  ]
    .filter(Boolean)
    .join("  ·  ");
  out.push(`<text x="32" y="${H - 22}" font-size="11.5" fill="${t.muted}">${esc(footer)}</text>`);

  out.push(`</svg>`);
  return out.join("\n");
}

// ---------- Main ----------

async function main() {
  const now = process.env.NOW ? new Date(process.env.NOW) : new Date();
  const data = await loadData(now);
  const ins = insights(data, now);
  await mkdir(OUT_DIR, { recursive: true });
  for (const theme of Object.keys(THEMES)) {
    await writeFile(`${OUT_DIR}/stats-${theme}.svg`, renderSvg(data, ins, theme, now));
  }
  console.log(
    `Done: ${fmt(ins.last12)} commits in 12 months, ${fmt(ins.prior)} before, ${ins.repoStats.total} ${ORG} repos.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
