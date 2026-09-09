import * as api from './api';
import { connect, provision, serialSupported, type Connection, type Ssid } from './improv';
import { SIZE, deckLength, render, type ViewState } from './render';
import type { DeckId, DeviceConfig, DevicePayload } from './types';

const DECK_LABEL: Record<DeckId, string> = {
  summary: 'Summary dial',
  repos: 'Repo cards',
  spark: 'Commit sparkline',
  activity: 'Activity ticker',
};

const view = document.getElementById('view')!;
const subtitle = document.getElementById('subtitle')!;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
}

const show = (...nodes: Node[]) => {
  view.replaceChildren(...nodes);
};

function note(msg: string, kind: 'err' | 'ok' | 'info' = 'info') {
  return el('p', { class: `note note-${kind}` }, msg);
}

/* ------------------------------- landing ------------------------------- */

function landing() {
  subtitle.textContent = 'Plug the knob into this computer to set it up';

  const btn = el('button', { class: 'primary' }, 'Connect device over USB');
  const status = el('div', { class: 'status' });

  btn.onclick = async () => {
    btn.disabled = true;
    status.replaceChildren(note('Waiting for you to pick a port…'));
    try {
      const conn = await connect();
      provisionView(conn);
    } catch (err) {
      status.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
      btn.disabled = false;
    }
  };

  const card = el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Set up your knob'),
    el(
      'p',
      { class: 'muted' },
      'Connect over USB and pick a Wi-Fi network. Nothing is typed twice — the ' +
        'device sends this page straight to its own settings afterwards.',
    ),
    btn,
    status,
  );

  if (!serialSupported()) {
    btn.disabled = true;
    status.replaceChildren(
      note(
        'This browser has no Web Serial. Use desktop Chrome, Edge, or Opera. ' +
          'On Linux you may also need to be in the "dialout" group.',
        'err',
      ),
    );
  }
  show(card);
}

/* ------------------------------ provisioning ------------------------------ */

function provisionView(conn: Connection) {
  subtitle.textContent = `${conn.info.name} · ${conn.info.firmware} ${conn.info.version}`;

  const select = el('select', { class: 'input' });
  select.append(el('option', { value: '' }, 'Scanning…'));
  const password = el('input', { class: 'input', type: 'password', placeholder: 'Wi-Fi password' });
  const go = el('button', { class: 'primary' }, 'Connect to Wi-Fi');
  const status = el('div', { class: 'status' });

  // Networks come from the DEVICE's own scan, so the list is what it can
  // actually reach -- not what this laptop can see.
  const stop = conn.improv.subscribeSSIDs((ssids: Ssid[] | null) => {
    if (!ssids) {
      select.replaceChildren(el('option', { value: '' }, 'Device cannot scan — type an SSID'));
      select.replaceWith(
        Object.assign(el('input', { class: 'input', placeholder: 'Network name' }), {
          id: 'ssid-manual',
        }),
      );
      return;
    }
    const current = select.value;
    select.replaceChildren(
      ...ssids.map((s) =>
        el('option', { value: s.name }, `${s.name}${s.secured ? '' : ' (open)'}  ·  ${s.rssi}dBm`),
      ),
    );
    if (current) select.value = current;
  });

  go.onclick = async () => {
    const ssid = select.value || (document.getElementById('ssid-manual') as HTMLInputElement)?.value;
    if (!ssid) {
      status.replaceChildren(note('Pick a network first.', 'err'));
      return;
    }
    go.disabled = true;
    status.replaceChildren(note('Connecting…'));
    try {
      await stop();
      const next = await provision(conn, ssid, password.value);
      if (next) {
        status.replaceChildren(note('Connected. Opening settings…', 'ok'));
        await conn.close();
        location.href = next;
      } else {
        status.replaceChildren(
          note('Wi-Fi connected, but the device sent no settings URL.', 'err'),
        );
        go.disabled = false;
      }
    } catch (err) {
      status.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
      go.disabled = false;
    }
  };

  show(
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Choose a network'),
      el('label', { class: 'lbl' }, 'Network'),
      select,
      el('label', { class: 'lbl' }, 'Password'),
      password,
      go,
      status,
    ),
  );
}

/* -------------------------------- config -------------------------------- */

function previewPanel(getPayload: () => DevicePayload | null) {
  const canvas = el('canvas', { class: 'screen', width: String(SIZE), height: String(SIZE) });
  const ctx = canvas.getContext('2d')!;
  const caption = el('p', { class: 'muted center' }, '');
  let state: ViewState = { deck: 'summary', index: 0 };

  const draw = () => {
    const p = getPayload();
    if (!p) return;
    if (!p.decks.includes(state.deck)) state.deck = p.decks[0] ?? 'summary';
    state.index = Math.min(state.index, deckLength(p, state.deck) - 1);
    render(ctx, p, state);
    caption.textContent = `${DECK_LABEL[state.deck]} — scroll to turn the knob, click to press it`;
  };

  // Mirror the real input model: rotate moves within a deck, press changes deck.
  canvas.onwheel = (e) => {
    e.preventDefault();
    const p = getPayload();
    if (!p) return;
    const len = deckLength(p, state.deck);
    state.index = (state.index + (e.deltaY > 0 ? 1 : -1) + len) % len;
    draw();
  };
  canvas.onclick = () => {
    const p = getPayload();
    if (!p) return;
    const i = p.decks.indexOf(state.deck);
    state.deck = p.decks[(i + 1) % p.decks.length]!;
    state.index = 0;
    draw();
  };

  return { node: el('div', { class: 'preview' }, canvas, caption), draw };
}

async function configView(session: api.Session) {
  subtitle.textContent = 'Settings';
  show(el('section', { class: 'card' }, note('Loading…')));

  let config: DeviceConfig;
  let payload: DevicePayload | null = null;
  try {
    config = await api.getConfig(session);
  } catch (err) {
    const retry = el('button', { class: 'ghost' }, 'Start over');
    retry.onclick = () => {
      api.clearSession();
      landing();
    };
    show(
      el(
        'section',
        { class: 'card' },
        note(`Could not load settings: ${err instanceof Error ? err.message : err}`, 'err'),
        retry,
      ),
    );
    return;
  }

  payload = await api.getPreview(session).catch(() => null);
  const preview = previewPanel(() => payload);

  const save = async (patch: Partial<DeviceConfig>) => {
    config = await api.putConfig(session, patch);
    payload = await api.getPreview(session).catch(() => payload);
    preview.draw();
  };

  /* deck toggles */
  const deckList = el('div', { class: 'rows' });
  for (const id of Object.keys(DECK_LABEL) as DeckId[]) {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = config.decks.includes(id);
    cb.onchange = async () => {
      const next = (Object.keys(DECK_LABEL) as DeckId[]).filter((d) =>
        d === id ? cb.checked : config.decks.includes(d),
      );
      if (next.length === 0) {
        cb.checked = true;
        return;
      }
      await save({ decks: next });
    };
    deckList.append(el('label', { class: 'row' }, cb, el('span', {}, DECK_LABEL[id])));
  }

  /* repo picker */
  const repoList = el('div', { class: 'rows' }, note('Loading repos…'));
  api
    .getRepos(session)
    .then(({ repos }) => {
      repoList.replaceChildren(
        ...repos.map((r) => {
          const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
          cb.checked = config.repos === null || config.repos.includes(r.name);
          cb.onchange = async () => {
            const checked = [...repoList.querySelectorAll('input:checked')].map(
              (n) => (n as HTMLElement).dataset.name!,
            );
            await save({ repos: checked });
          };
          cb.dataset.name = r.name;
          return el(
            'label',
            { class: 'row' },
            cb,
            el('span', {}, r.name),
            el('span', { class: 'tag' }, `★ ${r.stars}`),
          );
        }),
      );
    })
    .catch(() => repoList.replaceChildren(note('Could not load repos.', 'err')));

  /* theme */
  const accent = el('input', { type: 'color', class: 'swatch' }) as HTMLInputElement;
  accent.value = config.theme.accent;
  accent.onchange = () => save({ theme: { ...config.theme, accent: accent.value } });

  const bright = el('input', {
    type: 'range',
    min: '5',
    max: '100',
    class: 'range',
  }) as HTMLInputElement;
  bright.value = String(config.theme.bright);
  bright.onchange = () => save({ theme: { ...config.theme, bright: Number(bright.value) } });

  const rot = el('input', {
    type: 'range',
    min: '0',
    max: '60',
    class: 'range',
  }) as HTMLInputElement;
  rot.value = String(config.theme.rotSec);
  const rotLabel = el('span', { class: 'tag' }, config.theme.rotSec ? `${config.theme.rotSec}s` : 'off');
  rot.oninput = () => {
    rotLabel.textContent = rot.value === '0' ? 'off' : `${rot.value}s`;
  };
  rot.onchange = () => save({ theme: { ...config.theme, rotSec: Number(rot.value) } });

  const refreshBtn = el('button', { class: 'ghost' }, 'Refresh from GitHub now');
  const refreshStatus = el('span', { class: 'tag' }, '');
  refreshBtn.onclick = async () => {
    refreshBtn.disabled = true;
    refreshStatus.textContent = 'fetching…';
    try {
      await api.refresh(session);
      payload = await api.getPreview(session);
      preview.draw();
      refreshStatus.textContent = 'up to date';
    } catch (err) {
      refreshStatus.textContent = err instanceof Error ? err.message : 'failed';
    }
    refreshBtn.disabled = false;
  };

  show(
    el(
      'div',
      { class: 'split' },
      preview.node,
      el(
        'div',
        { class: 'stack' },
        el('section', { class: 'card' }, el('h2', {}, 'Screens'), deckList),
        el('section', { class: 'card' }, el('h2', {}, 'Repos'), repoList),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'Look'),
          el('label', { class: 'lbl' }, 'Accent'),
          accent,
          el('label', { class: 'lbl' }, 'Brightness'),
          bright,
          el('label', { class: 'lbl' }, 'Auto-advance'),
          el('div', { class: 'row' }, rot, rotLabel),
        ),
        el('section', { class: 'card' }, el('div', { class: 'row' }, refreshBtn, refreshStatus)),
      ),
    ),
  );
  preview.draw();
}

/* --------------------------------- boot --------------------------------- */

const session = api.readSession();
if (session) void configView(session);
else landing();
