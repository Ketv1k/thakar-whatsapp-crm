// Team & account: your own login (password, notifications on this device)
// and, for the owner, the team - add people, reset a password, remove access.
import { state, api, post, patch, del, el, escapeHtml, ago, toast, ico, isOwner, isCurrent } from './core.js';
import { notificationsHtml, wireNotifications } from './notify.js';

const ROLE_LABELS = { owner: 'Owner', team: 'Team member' };
const ROLE_HELP = {
  owner: 'Everything, including campaigns, automations, lists and the team.',
  team: 'Chats, cart links, customers and COD orders. No campaigns, automations, list downloads or team changes.',
};

function passwordCard(name, email, password) {
  const site = location.origin;
  const text = `Hi ${name}, here's your login for the Thakar Kitchen inbox:\n${site}\nEmail: ${email}\nPassword: ${password}\nYou can change the password after logging in (Team & account).`;
  return `
    <div class="notice pw-card">
      <p><b>Share this with ${escapeHtml(name)}.</b> It's shown only once.</p>
      <pre>${escapeHtml(text)}</pre>
      <button type="button" class="btn btn-small" data-copy-pw>Copy message</button>
    </div>`;
}

function wireCopy(box, name, email, password) {
  const btn = box.querySelector('[data-copy-pw]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(box.querySelector('.pw-card pre').textContent);
      toast('Copied. Paste it into WhatsApp to send it.');
    } catch (err) {
      toast('Select the text and copy it.');
    }
  });
}

function accountHtml(me) {
  return `
    <section class="card">
      <h2>You</h2>
      <p class="card-note"><b>${escapeHtml(me.name)}</b>${me.email ? ` · ${escapeHtml(me.email)}` : ''} · ${escapeHtml(ROLE_LABELS[me.role] || me.role)}</p>
      ${me.viaCode
        ? '<p class="card-note">You logged in with the access code. Add yourself below as an owner with your email to get your own password — then you can stop sharing the code.</p>'
        : `<form class="pw-form" data-pw-form>
            <input type="password" data-pw-current autocomplete="current-password" placeholder="Current password" aria-label="Current password" />
            <input type="password" data-pw-new autocomplete="new-password" placeholder="New password (8+ characters)" aria-label="New password" />
            <button type="submit" class="btn btn-small btn-dark">Change password</button>
          </form>`}
    </section>
    <section class="card" data-notify>${notificationsHtml()}</section>`;
}

function memberRow(m, me) {
  const self = m._id === me._id;
  return `
    <div class="member" data-member="${m._id}">
      <span class="avatar" aria-hidden="true">${escapeHtml(m.name.slice(0, 1).toUpperCase())}</span>
      <span class="member-main">
        <b>${escapeHtml(m.name)}${self ? ' (you)' : ''}</b>
        <small>${escapeHtml(m.email)} · ${m.lastLoginAt ? `last in ${escapeHtml(ago(m.lastLoginAt))} ago` : 'not logged in yet'}</small>
      </span>
      <select data-role aria-label="Role for ${escapeHtml(m.name)}" ${self ? 'disabled' : ''}>
        ${Object.entries(ROLE_LABELS).map(([k, l]) => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="member-actions">
        <button type="button" class="link-btn" data-reset>New password</button>
        ${self ? '' : '<button type="button" class="link-btn danger" data-remove>Remove</button>'}
      </span>
      <div class="member-out" data-out></div>
    </div>`;
}

async function renderTeamList(box, me) {
  let team;
  try {
    team = await api('/api/team');
  } catch (err) {
    box.innerHTML = `<p class="warn">${escapeHtml(err.message)}</p>`;
    return;
  }
  box.innerHTML = `
    <div class="members">${team.map((m) => memberRow(m, me)).join('') || '<p class="card-note">No one yet. Add yourself first (as Owner), then your team.</p>'}</div>
    <form class="add-member" data-add>
      <h3>Add someone</h3>
      <div class="row-fields">
        <input data-name placeholder="Name, e.g. Priya" maxlength="60" aria-label="Name" />
        <input data-email type="email" placeholder="Their email" aria-label="Email" />
        <select data-new-role aria-label="Role"><option value="team">Team member</option><option value="owner">Owner</option></select>
        <button type="submit" class="btn btn-primary">Add</button>
      </div>
      <p class="muted" data-role-help>${escapeHtml(ROLE_HELP.team)}</p>
      <div data-added></div>
    </form>`;

  const form = box.querySelector('[data-add]');
  form.querySelector('[data-new-role]').addEventListener('change', (e) => {
    form.querySelector('[data-role-help]').textContent = ROLE_HELP[e.target.value];
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = form.querySelector('[data-name]').value.trim();
    const email = form.querySelector('[data-email]').value.trim();
    try {
      const r = await post('/api/team', { name, email, role: form.querySelector('[data-new-role]').value });
      await renderTeamList(box, me);
      const added = box.querySelector('[data-added]');
      added.innerHTML = passwordCard(r.member.name, r.member.email, r.password);
      wireCopy(added, r.member.name, r.member.email, r.password);
    } catch (err) {
      toast(err.message);
    }
  });

  for (const row of box.querySelectorAll('[data-member]')) {
    const id = row.dataset.member;
    const m = team.find((x) => x._id === id);
    row.querySelector('[data-role]').addEventListener('change', async (e) => {
      try {
        await patch(`/api/team/${id}`, { role: e.target.value });
        toast(`${m.name} is now ${ROLE_LABELS[e.target.value].toLowerCase()}`);
      } catch (err) {
        toast(err.message);
        e.target.value = m.role;
      }
    });
    row.querySelector('[data-reset]').addEventListener('click', async () => {
      if (!confirm(`Give ${m.name} a new password? They'll be logged out on every device until they use it.`)) return;
      try {
        const r = await post(`/api/team/${id}/reset-password`);
        const out = row.querySelector('[data-out]');
        out.innerHTML = passwordCard(m.name, m.email, r.password);
        wireCopy(out, m.name, m.email, r.password);
      } catch (err) {
        toast(err.message);
      }
    });
    const remove = row.querySelector('[data-remove]');
    if (remove) {
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove ${m.name}? They're logged out at once and can't log in again. Their name stays on replies they sent.`)) return;
        try {
          await del(`/api/team/${id}`);
          toast(`${m.name} removed`);
          renderTeamList(box, me);
        } catch (err) {
          toast(err.message);
        }
      });
    }
  }
}

export async function showTeam() {
  const view = el('view-team');
  const me = state.config.user || { name: 'You', role: 'owner', viaCode: true };
  view.innerHTML = `
    <div class="page team-page">
      <header class="page-head"><div><h1 class="page-title">Team &amp; account</h1>
        <p class="page-sub">${isOwner() ? 'Your login, notifications on this device, and who else can use the inbox.' : 'Your login and notifications on this device.'}</p></div></header>
      ${accountHtml(me)}
      ${isOwner()
        ? `<section class="card"><h2>Team</h2>
            <p class="card-note">Everyone gets their own login. <b>Owners</b>: ${escapeHtml(ROLE_HELP.owner)} <b>Team members</b>: ${escapeHtml(ROLE_HELP.team)} Replies show who sent them.</p>
            <div data-team><div class="muted">Loading…</div></div></section>`
        : ''}
    </div>`;
  wireNotifications(view.querySelector('[data-notify]'));
  const pw = view.querySelector('[data-pw-form]');
  if (pw) {
    pw.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await post('/api/me/password', { current: pw.querySelector('[data-pw-current]').value, password: pw.querySelector('[data-pw-new]').value });
        pw.reset();
        toast('Password changed. Other devices were logged out.');
      } catch (err) {
        toast(err.message);
      }
    });
  }
  if (isOwner() && isCurrent('team')) await renderTeamList(view.querySelector('[data-team]'), me);
}
