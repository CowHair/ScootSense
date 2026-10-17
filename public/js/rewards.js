import { $, api, toast, esc, ic } from './ui.js';

const short = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const when = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const phantom = () => window.phantom?.solana?.isPhantom ? window.phantom.solana : window.solana?.isPhantom ? window.solana : null;

export function initRewards() {
  $('#ledger-close').onclick = () => $('#ledger').close();
  $('#ledger').addEventListener('click', (e) => { if (e.target.id === 'ledger') $('#ledger').close(); });
}

export async function onShowRewards() {
  const box = $('#rewards-body');
  let me;
  try { me = await api('/api/chain/me'); } catch { box.innerHTML = '<p class="secondary">Rewards are not available right now.</p>'; return; }
  const list = me.rewards.slice(0, 5).map((r) => `<li><b>+${r.amount}</b><span>${esc(r.reason)}</span>
    ${r.url ? `<a href="${r.url}" target="_blank" rel="noopener" aria-label="View this reward on Solana Explorer">${ic('open_in_new')}</a>` : `<i class="chip">${r.status}</i>`}</li>`).join('');
  box.innerHTML = `
    <div class="scoot-total"><b>${me.total}</b><span>SCOOT</span></div>
    <p class="secondary">${me.total
      ? `${me.sent} sent to your wallet${me.waiting ? ` · ${me.waiting} waiting${me.wallet ? '' : ' for a wallet'}` : ''}`
      : 'Earn SCOOT when riders confirm a pothole you found, or when litter you reported gets picked up.'}</p>
    ${list ? `<ul class="scoot-list">${list}</ul>` : ''}
    <div class="scoot-wallet">${me.wallet
      ? `${ic('account_balance_wallet')}<span>Wallet <a href="${me.walletUrl}" target="_blank" rel="noopener">${short(me.wallet)}</a></span><button class="btn flat" data-change>Change</button>`
      : `<button class="btn raised primary" data-connect>${ic('account_balance_wallet')} ${phantom() ? 'Connect Phantom' : 'Add wallet address'}</button>`}</div>
    <form class="scoot-paste hidden" data-paste>
      <div class="textfield grow"><input id="wallet-addr" placeholder=" " autocomplete="off" spellcheck="false" /><label for="wallet-addr">Solana wallet address</label></div>
      <button class="btn raised primary">Save</button>
    </form>
    <p class="secondary small">${me.footprint.transactions
      ? `Your ${me.footprint.transactions} reward transaction${me.footprint.transactions === 1 ? '' : 's'} used about ${me.footprint.gCo2} g CO₂ on Solana.`
      : 'Each reward is one Solana transaction, about 0.00257 g CO₂.'}
      Source: ${esc(me.footprint.source)}, ${esc(me.footprint.asOf)}. Devnet test tokens, no monetary value.</p>
    <div class="card-actions"><button class="btn flat" data-ledger>${ic('verified')} See the public record</button></div>`;

  box.querySelector('[data-ledger]').onclick = () => openLedger();
  const paste = box.querySelector('[data-paste]');
  const showPaste = () => { paste.classList.remove('hidden'); paste.querySelector('input').focus(); };
  box.querySelector('[data-change]')?.addEventListener('click', showPaste);
  box.querySelector('[data-connect]')?.addEventListener('click', async () => {
    const p = phantom();
    if (!p) return showPaste();
    try {
      const { publicKey } = await p.connect();
      await saveWallet(publicKey.toString());
    } catch (e) {
      toast(e.message || 'Phantom did not connect', 'err');
    }
  });
  paste.onsubmit = (e) => { e.preventDefault(); saveWallet($('#wallet-addr').value); };
}

async function saveWallet(address) {
  try {
    await api('/api/chain/wallet', { method: 'PUT', body: { address } });
    toast('Wallet linked. Waiting rewards are on their way.', 'ok');
    onShowRewards();
  } catch (e) {
    toast(e.message, 'err');
  }
}

export async function openLedger(ref) {
  const dlg = $('#ledger');
  $('#ledger-title').textContent = ref ? `Public record for ${ref}` : 'Public record';
  $('#ledger-list').innerHTML = '<li class="secondary">Loading…</li>';
  if (!dlg.open) dlg.showModal();
  const { records, enabled } = await api(`/api/chain/ledger${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`);
  $('#ledger-list').innerHTML = records.length ? records.map(entry).join('')
    : `<li class="secondary">${ref ? `${esc(ref)} is not on the record yet. It is written to Solana once riders confirm it.` : 'Nothing confirmed yet.'}</li>`;
  if (!enabled) $('#ledger-list').insertAdjacentHTML('afterbegin', '<li class="secondary">Solana is not connected on this server yet, so entries are queued.</li>');
  $('#ledger-list').querySelectorAll('[data-verify]').forEach((b) => (b.onclick = () => runVerify(b, false)));
}

function entry(r) {
  const [, what = '', detail = ''] = r.memo.split(' | ');
  const hash = /sha256:([0-9a-f]+)/.exec(r.memo)?.[1] || '';
  return `<li class="ledger-entry" data-id="${r.id}">
    <div class="le-head">${ic(r.kind === 'hazard' ? 'report' : 'delete_sweep')}<b>${esc(what)}</b><i class="chip ${r.status === 'on-chain' ? 'ok' : ''}">${r.status}</i></div>
    <div class="secondary small">${esc(detail)} · ${when(r.time)}</div>
    <code class="le-hash" title="SHA-256 of the facts stored in our database">sha256 ${hash.slice(0, 16)}…</code>
    <div class="le-actions">${r.url ? `<button class="btn flat" data-verify>${ic('fact_check')} Verify</button>
      <a class="btn flat" href="${r.url}" target="_blank" rel="noopener">${ic('open_in_new')} Explorer</a>` : ''}</div>
    <div class="le-result" aria-live="polite"></div></li>`;
}

async function runVerify(btn, tamper) {
  const li = btn.closest('.ledger-entry');
  const out = li.querySelector('.le-result');
  out.innerHTML = '<span class="spinner"></span> Reading the transaction from Solana…';
  try {
    const v = await api(`/api/chain/records/${li.dataset.id}/verify${tamper ? '?tamper=1' : ''}`);
    out.className = `le-result ${v.match ? 'ok' : 'bad'}`;
    out.innerHTML = v.match
      ? `${ic('verified')}<div><b>Matches Solana.</b> The facts in our database hash to the same value written on-chain${v.blockTime ? ` on ${when(v.blockTime)}` : ''} (slot ${v.slot}). Nobody has changed this record.
          <button class="btn flat" data-tamper>What if someone edits it?</button></div>`
      : `${ic('gpp_bad')}<div><b>Does not match Solana.</b> ${v.edit ? `Changing <i>${esc(v.edit.field)}</i> from ${v.edit.from} to ${v.edit.to} gives hash ${v.dbHash.slice(0, 12)}…, but the chain says ${String(v.onChainHash).slice(0, 12)}…. Any edit is caught.` : 'Our database no longer agrees with the chain.'}
          ${v.edit ? '<span class="secondary small">This was a simulation on a copy; nothing was changed.</span>' : ''}</div>`;
    out.querySelector('[data-tamper]')?.addEventListener('click', (e) => runVerify(e.currentTarget, true));
  } catch (e) {
    out.className = 'le-result bad';
    out.textContent = e.message;
  }
}

export async function hazardChainLine(el, ref) {
  try {
    const { records } = await api(`/api/chain/ledger?ref=${ref}`);
    if (!records.length) { el.innerHTML = ''; return; }
    const onChain = records.some((r) => r.status === 'on-chain');
    el.innerHTML = `<button class="chain-line">${ic('verified')}<span>${onChain ? "On Solana's public record" : 'Being written to Solana'}</span>${ic('chevron_right')}</button>`;
    el.querySelector('button').onclick = () => openLedger(ref);
  } catch { el.innerHTML = ''; }
}
