// Phone-only "More" tab: the pages that don't fit in the bottom bar.
import { state, el, ico, isOwner } from './core.js';

export function showMore() {
  el('view-more').innerHTML = `
    <div class="page">
      <header class="page-head"><h1 class="page-title">More</h1></header>
      <nav class="more-list" aria-label="More">
        ${isOwner() ? `<a href="#/automations">${ico('bolt')}<span><b>Automations</b><small>Order updates, COD, cart and reorder reminders</small></span>${ico('forward')}</a>` : ''}
        <a href="#/orders">${ico('wallet')}<span><b>COD orders</b><small>Who confirmed, who wants to cancel</small></span>${ico('forward')}</a>
        <a href="#/team">${ico('user')}<span><b>Team &amp; account</b><small>Your password, notifications${isOwner() ? ', your team' : ''}</small></span>${ico('forward')}</a>
        ${state.config.testMode ? `<a href="#/test">${ico('flask')}<span><b>Test</b><small>Pretend to be a customer</small></span>${ico('forward')}</a>` : ''}
        <button type="button" data-logout>${ico('logout')}<span><b>Log out</b><small>On this phone</small></span></button>
      </nav>
    </div>`;
  el('view-more').querySelector('[data-logout]').addEventListener('click', () => el('logout-button').click());
}
