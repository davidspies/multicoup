import { esc } from '../util.js';

let picked = new Set(); // captain's crew selection in progress
let pickedFor = null; // which proposal the selection belongs to

const SIDE_LABEL = { crew: 'Loyal crew', saboteurs: 'Saboteur' };
const TAG_LABEL = { saboteur: 'saboteur', 'navigator?': 'Navigator?' };

function missionTrack(g) {
  return `<div class="track">${g.missions
    .map((m, i) => {
      const cls = m.result === 'success' ? 'ok' : m.result === 'fail' ? 'bad' : i === g.mission && g.phase !== 'over' ? 'now' : '';
      const inner = m.result === 'success' ? '✓' : m.result === 'fail' ? `✗${m.fails > 1 ? m.fails : ''}` : m.size;
      return `<div class="mission ${cls}" title="Mission ${i + 1}: crew of ${m.size}${m.twoFails ? ', needs 2 sabotage cards to fail' : ''}">
        <span class="num">${inner}</span>${m.twoFails ? '<span class="two">2 fails</span>' : ''}</div>`;
    })
    .join('')}</div>
    <div class="proposals">${Array.from({ length: g.maxProposals }, (_, i) => `<span class="dot${g.phase !== 'over' && i < g.attempt - 1 ? ' used' : ''}${g.phase !== 'over' && i === g.attempt - 1 ? ' cur' : ''}"></span>`).join('')}
      <span class="muted">proposal ${g.phase === 'over' ? '-' : g.attempt} of ${g.maxProposals}</span></div>`;
}

// ui: {state, nameOf, sendMove, rerenderDecision, showModal}
export function renderTable(ui, el) {
  const { state: st } = ui;
  const g = st.game;
  const knows = new Map((g.you?.knows ?? []).map((k) => [k.id, k.tag]));
  const navCandidates = [...knows.values()].filter((t) => t === 'navigator?').length;
  const myScans = new Map((g.you?.scans ?? []).map((x) => [x.target, x.side]));
  const last = g.proposals.at(-1);
  const showLast = last && (g.phase === 'propose' || g.phase === 'mission' || g.phase === 'over' || g.phase === 'hunt');
  el.innerHTML =
    `<div class="hb-board">${missionTrack(g)}</div>` +
    g.players
      .map((p) => {
        const badges = [];
        if (g.phase !== 'over' && g.leader === p.id) badges.push('<span class="badge2 lead">captain</span>');
        if (g.team?.includes(p.id)) badges.push('<span class="badge2 team">on crew</span>');
        if (knows.has(p.id)) {
          const tag = knows.get(p.id);
          // With no Mimic in play the Medic's single candidate is certain.
          const label = tag === 'navigator?' && navCandidates === 1 ? 'Navigator' : TAG_LABEL[tag];
          badges.push(`<span class="badge2 know-${tag === 'saboteur' ? 'bad' : 'nav'}">${label}</span>`);
        }
        if (g.scanHolder === p.id && g.phase !== 'over') badges.push('<span class="badge2 scan">🔍 Scanner</span>');
        if (myScans.has(p.id)) badges.push(`<span class="badge2 ${myScans.get(p.id) === 'crew' ? 'side-crew' : 'know-bad'}">scanned: ${myScans.get(p.id) === 'crew' ? 'loyal' : 'saboteur'}</span>`);
        if (p.role) badges.push(`<span class="badge2 ${['crew', 'navigator', 'medic'].includes(p.role) ? 'side-crew' : 'side-sab'}">${g.roleNames[p.role]}</span>`);
        if (g.hunter === p.id) badges.push('<span class="badge2 know-bad">Hunter</span>');
        if (g.hunted === p.id) badges.push('<span class="badge2">🎯 named</span>');
        let status = '';
        if (g.phase === 'vote') status = p.voted ? 'voted' : 'voting…';
        else if (g.phase === 'mission' && g.team.includes(p.id)) status = p.played ? 'card played' : 'on mission…';
        else if (g.awaiting.includes(p.id)) status = 'deciding…';
        const vote = showLast ? `<span class="vote ${last.votes[p.id] ? 'yes' : 'no'}">${last.votes[p.id] ? '✓' : '✗'}</span>` : '';
        return `<button class="seat hb${g.leader === p.id && g.phase !== 'over' ? ' turn' : ''}${p.id === st.you ? ' me-seat' : ''}" data-history="${p.id}" title="Show ${esc(p.name)}'s voting history">
          <div class="nm">${esc(p.name)}${p.id === st.you ? ' (you)' : ''} ${vote}</div>
          <div class="badges">${badges.join('')}</div>
          <div class="thinking">${status}</div>
        </button>`;
      })
      .join('') +
    `<button class="small all-votes" data-history="*">All votes</button>`;
  el.querySelectorAll('[data-history]').forEach((b) => (b.onclick = () => ui.showModal(historyHtml(ui, b.dataset.history))));
}

function historyHtml(ui, pid) {
  const g = ui.state.game;
  const n = ui.nameOf;
  const scanLine = (x) => `${esc(n(x.by))} scanned ${esc(n(x.target))} after mission ${x.afterMission + 1}`;
  if (!g.proposals.length) return '<h3>Voting history</h3><p class="muted">No votes yet this game.</p>';
  const outcome = (pr) => {
    if (!pr.approved) return '<span class="muted">rejected</span>';
    const m = g.missions[pr.mission];
    if (m.result === 'success') return '<span class="ok-t">mission succeeded</span>';
    if (m.result === 'fail') return `<span class="bad-t">mission failed (${m.fails} sabotage)</span>`;
    return 'approved';
  };
  const mark = (v) => `<span class="vote ${v ? 'yes' : 'no'}">${v ? '✓' : '✗'}</span>`;
  if (pid === '*') {
    return `<h3>All votes, game ${ui.state.gameNumber}</h3><div class="grid-wrap"><table class="votegrid"><tr><th>Mission</th><th>Captain</th><th>Crew</th>${g.players.map((p) => `<th>${esc(p.name)}</th>`).join('')}<th>Result</th></tr>
      ${g.proposals
        .map(
          (pr) => `<tr><td>${pr.mission + 1}.${pr.attempt}</td><td>${esc(n(pr.leader))}</td><td>${pr.team.map((id) => esc(n(id))).join(', ')}</td>
          ${g.players.map((p) => `<td class="${pr.team.includes(p.id) ? 'oncrew' : ''}">${mark(pr.votes[p.id])}</td>`).join('')}<td>${outcome(pr)}</td></tr>`,
        )
        .join('')}</table></div><p class="muted">Shaded cells: that player was on the proposed crew.</p>
      ${g.scans.length ? `<p><b>Scans:</b> ${g.scans.map(scanLine).join('; ')}.</p>` : ''}`;
  }
  const p = g.players.find((x) => x.id === pid);
  const rows = g.proposals.map(
    (pr) => `<tr><td>${pr.mission + 1}.${pr.attempt}</td><td>${esc(n(pr.leader))}${pr.leader === pid ? ' ★' : ''}</td>
      <td>${pr.team.map((id) => (id === pid ? `<b>${esc(n(id))}</b>` : esc(n(id)))).join(', ')}</td><td>${mark(pr.votes[pid])}</td><td>${outcome(pr)}</td></tr>`,
  );
  const yes = g.proposals.filter((pr) => pr.votes[pid]).length;
  const onCrew = g.proposals.filter((pr) => pr.approved && pr.team.includes(pid));
  const failedWith = onCrew.filter((pr) => g.missions[pr.mission].result === 'fail').length;
  return `<h3>${esc(p.name)}'s voting history</h3>
    <p class="muted">Approved ${yes} of ${g.proposals.length} proposals · went on ${onCrew.length} mission${onCrew.length === 1 ? '' : 's'}${onCrew.length ? `, ${failedWith} of which failed` : ''}.</p>
    <div class="grid-wrap"><table class="votegrid"><tr><th>Mission</th><th>Captain</th><th>Proposed crew</th><th>Vote</th><th>Result</th></tr>${rows.join('')}</table></div>
    <p class="muted">★ = they were captain. Bold = they were on the proposed crew.</p>
    ${g.scans.some((x) => x.by === pid || x.target === pid) ? `<p><b>Scans:</b> ${g.scans.filter((x) => x.by === pid || x.target === pid).map(scanLine).join('; ')}.</p>` : ''}`;
}

export function renderMe(ui, el) {
  const { state: st } = ui;
  const g = st.game;
  const y = g.you;
  el.innerHTML = `<div class="role-card ${y.side === 'crew' ? 'side-crew' : 'side-sab'}"><div class="rname">${esc(y.roleName)}</div><div class="rside">${SIDE_LABEL[y.side]}</div></div>
    <div class="info"><div class="nm">${esc(ui.nameOf(st.you))} (you)</div>
    <div>${esc(y.blurb)}</div>
    ${y.knowsText ? `<div class="knows"><b>What you know:</b> ${esc(y.knowsText)}</div>` : ''}
    ${y.scans.map((x) => `<div class="knows"><b>Your scan:</b> ${esc(ui.nameOf(x.target))} is ${x.side === 'crew' ? 'loyal crew' : 'a saboteur'}.</div>`).join('')}
    <div class="muted">Special roles this game: ${g.specialRoles.length ? g.specialRoles.map(esc).join(', ') : 'none'}. Tap a player to see their votes.</div></div>`;
}

export function renderDecision(ui, el) {
  const { state: st } = ui;
  const g = st.game;
  const idx = (m) => st.legal.indexOf(m);
  const propose = st.legal.find((m) => m.type === 'propose');
  if (propose) {
    const key = `${st.gameNumber}:${g.mission}:${g.attempt}`;
    if (pickedFor !== key) {
      picked = new Set();
      pickedFor = key;
    }
    el.innerHTML = `<h3>Choose ${propose.size} crew for mission ${g.mission + 1}</h3>
      <div class="moves">${propose.choices
        .map((id) => `<button class="${picked.has(id) ? 'primary' : ''}" data-toggle="${id}">${picked.has(id) ? '✓ ' : ''}${esc(ui.nameOf(id))}${id === st.you ? ' (you)' : ''}</button>`)
        .join('')}</div>
      <div class="targets"><button class="primary" id="hb-propose" ${picked.size === propose.size ? '' : 'disabled'}>Propose this crew (${picked.size}/${propose.size})</button></div>`;
    el.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = () => {
        const id = b.dataset.toggle;
        if (picked.has(id)) picked.delete(id);
        else if (picked.size < propose.size) picked.add(id);
        ui.rerenderDecision();
      };
    });
    el.querySelector('#hb-propose').onclick = () => ui.sendMove({ type: 'propose', team: [...picked] });
    return;
  }
  const titles = { vote: 'Vote on this crew', mission: 'Play your mission card', hunt: 'Name the Navigator', scan: 'Use the Scanner' };
  let extra = '';
  if (g.phase === 'vote') extra = `<p>Proposed crew: <b>${g.team.map((id) => esc(ui.nameOf(id))).join(', ')}</b>${g.attempt === g.maxProposals ? ' <span class="bad-t">(last proposal: rejecting it hands the saboteurs the win)</span>' : ''}</p>`;
  if (g.phase === 'mission' && st.legal.length === 1) extra = '<p class="muted">Loyal crew can only play success.</p>';
  if (g.phase === 'scan') extra = '<p class="muted">Only you will see their loyalty. The Scanner then passes to them.</p>';
  el.innerHTML = `<h3>${titles[g.phase]}</h3>${extra}<div class="moves">${st.legal
    .map((m) => {
      const cls = (m.type === 'vote' && !m.approve) || (m.type === 'mission' && m.card === 'sabotage') ? 'danger-btn' : m.type === 'scan' ? '' : 'primary';
      return `<button class="${cls}" data-move="${idx(m)}">${esc(m.label)}</button>`;
    })
    .join('')}</div>`;
  el.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => {
      const { label, ...move } = st.legal[Number(b.dataset.move)];
      ui.sendMove(move);
    };
  });
}

const OPTION_LABELS = {
  navigator: 'Navigator + Hunter',
  medic: 'Medic',
  mimic: 'Mimic',
  ghost: 'Ghost',
  rogue: 'Rogue',
  scanner: 'Scanner',
};

export const settingsHtml = (st, isHost) =>
  isHost
    ? `<fieldset class="roles"><legend>Special roles</legend>${Object.entries(OPTION_LABELS)
        .map(([k, label]) => `<label class="check"><input type="checkbox" data-opt="${k}" ${st.options[k] ? 'checked' : ''} ${st.inProgress ? 'disabled' : ''}> ${label}</label>`)
        .join('')}</fieldset>`
    : `<span class="muted">Special roles: ${Object.entries(OPTION_LABELS).filter(([k]) => st.options[k]).map(([, l]) => l).join(', ') || 'none'}</span>`;

export function bindSettings(ui, el) {
  el.querySelectorAll('[data-opt]').forEach((c) => {
    c.onchange = () => ui.send('options', { options: { [c.dataset.opt]: c.checked } });
  });
}
