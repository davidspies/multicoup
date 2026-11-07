import { esc, cap } from '../util.js';

const GLYPH = { duke: '♛', assassin: '🗡', captain: '⚓', ambassador: '✉', contessa: '♕' };
const ACTION_TEXT = {
  income: 'Income',
  foreign_aid: 'Foreign Aid',
  coup: 'Coup',
  tax: 'Tax',
  assassinate: 'Assassinate',
  steal: 'Steal',
  exchange: 'Exchange',
};
const ACTION_HELP = {
  income: '+1 coin',
  foreign_aid: '+2 coins · Duke can block',
  coup: 'Pay 7 · unstoppable',
  tax: 'Duke · +3 coins',
  assassinate: 'Assassin · pay 3',
  steal: 'Captain · take 2',
  exchange: 'Ambassador · swap cards',
};

let pendingAction = null; // a targeted action waiting for its target

function cardHtml(role, { lost = false, big = false } = {}) {
  if (!role) return `<div class="card back${big ? ' big' : ''}"></div>`;
  return `<div class="card r-${role}${lost ? ' lost' : ''}${big ? ' big' : ''}" title="${cap(role)}"><span class="glyph">${GLYPH[role]}</span>${cap(role)}</div>`;
}

// ui: {state, nameOf, sendMove, rerenderDecision}
export function renderTable(ui, el) {
  const { state: st } = ui;
  const g = st.game;
  el.innerHTML = g.players
    .filter((p) => p.id !== st.you)
    .map((p) => {
      const hiddenCards = Array.from({ length: p.influence }, () => cardHtml(null)).join('');
      const lost = p.revealed.map((r) => cardHtml(r, { lost: true })).join('');
      const isTurn = g.phase !== 'over' && g.turn === p.id;
      const waiting = g.awaiting.includes(p.id) && g.phase !== 'over' ? 'deciding…' : '';
      const winner = g.winner === p.id ? ' 🏆' : '';
      return `<div class="seat${isTurn ? ' turn' : ''}${p.alive ? '' : ' out'}">
        <div class="nm">${esc(p.name)}${winner}</div>
        <div class="meta"><span class="coins">🪙 ${p.coins}</span><span>${p.alive ? `${p.influence} influence` : 'out'}</span></div>
        <div class="cards">${hiddenCards}${lost}</div>
        <div class="thinking">${waiting}</div>
      </div>`;
    })
    .join('');
}

export function renderMe(ui, el) {
  const { state: st } = ui;
  const g = st.game;
  const me = g.players.find((p) => p.id === st.you);
  el.innerHTML = `<div class="cards">${me.hand.map((r) => cardHtml(r, { big: true })).join('')}${me.revealed.map((r) => cardHtml(r, { lost: true, big: true })).join('')}</div>
    <div class="info"><div class="nm">${esc(me.name)} (you)${g.winner === me.id ? ' 🏆' : ''}</div>
    <div class="coins">🪙 ${me.coins} coins</div>
    <div class="muted">${me.alive ? (g.turn === me.id && g.phase !== 'over' ? 'Your turn' : '') : 'You are out of this game.'}</div>
    <div class="muted">Court deck: ${g.deckCount}</div></div>`;
}

export function renderDecision(ui, el) {
  const { state: st } = ui;
  const g = st.game;
  if (pendingAction && !st.legal.some((m) => m.action === pendingAction)) pendingAction = null;
  const idx = (m) => st.legal.indexOf(m);
  let html = '';
  if (g.phase === 'action') {
    html += `<h3>Choose an action</h3><div class="moves">`;
    const seen = new Set();
    for (const m of st.legal) {
      if (seen.has(m.action)) continue;
      seen.add(m.action);
      const claim = ['tax', 'assassinate', 'steal', 'exchange'].includes(m.action);
      html += `<button class="${claim ? 'claim' : ''}${pendingAction === m.action ? ' primary' : ''}" ${m.target ? `data-pick="${m.action}"` : `data-move="${idx(m)}"`}>
        <b>${ACTION_TEXT[m.action]}</b><br><small>${ACTION_HELP[m.action]}</small></button>`;
    }
    html += `</div>`;
    if (pendingAction) {
      html += `<div class="targets"><span>${ACTION_TEXT[pendingAction]} whom?</span>`;
      for (const m of st.legal.filter((x) => x.action === pendingAction)) html += `<button class="primary" data-move="${idx(m)}">${esc(ui.nameOf(m.target))}</button>`;
      html += `<button data-cancel>Cancel</button></div>`;
    }
  } else {
    const titles = { challenge: 'Challenge?', block: 'Block?', lose: 'Choose a card to lose', exchange: 'Choose which cards to keep' };
    const title = st.legal.some((m) => m.type === 'block') && g.phase === 'challenge' ? 'Challenge, block, or allow?' : titles[g.phase];
    html += `<h3>${title}</h3>`;
    if (g.phase === 'exchange') html += `<p class="muted">You drew: ${g.drawn.map(cap).join(', ')}</p>`;
    html += `<div class="moves">${st.legal.map((m) => `<button class="${m.type === 'pass' ? '' : 'primary'}" data-move="${idx(m)}">${esc(m.label)}</button>`).join('')}</div>`;
  }
  el.innerHTML = html;
  el.querySelectorAll('[data-move]').forEach((b) => {
    b.onclick = () => {
      const { label, ...move } = st.legal[Number(b.dataset.move)];
      pendingAction = null;
      ui.sendMove(move);
    };
  });
  el.querySelectorAll('[data-pick]').forEach((b) => {
    b.onclick = () => {
      pendingAction = b.dataset.pick;
      ui.rerenderDecision();
    };
  });
  el.querySelectorAll('[data-cancel]').forEach((b) => {
    b.onclick = () => {
      pendingAction = null;
      ui.rerenderDecision();
    };
  });
}

export const settingsHtml = (st, isHost) =>
  isHost
    ? `<label>Challenge/block auto-pass (s, 0 = off)<input id="set-timeout" type="number" min="0" max="3600" value="${st.settings.responseTimeoutSec}"></label>`
    : `<span class="muted">Auto-pass: ${st.settings.responseTimeoutSec ? `${st.settings.responseTimeoutSec}s` : 'off'}</span>`;

export function bindSettings() {}
