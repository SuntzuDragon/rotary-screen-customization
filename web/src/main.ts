import { applyAccent } from './accent';
import * as api from './api';
import { DEMO_CONFIG, demoPayload } from './demo';
import { flashFirmware } from './flash';
import {
  closeShared,
  liveConnection,
  onConnectionChange,
  openShared,
  takePort,
  provision,
  serialSupported,
  type Connection,
} from './improv';
import { SIZE, buildCards, nextSection, render, type Card } from './render';
import {
  DEFAULT_ACCENT,
  MAX_DEVICE_REPOS,
  type DeckId,
  type DeviceConfig,
  type DevicePayload,
} from './types';

const DECK_LABEL: Record<DeckId, string> = {
  summary: 'Summary dial',
  repos: 'Repo cards',
  activity: 'Activity ticker',
};

const REPO_URL = 'https://github.com/SuntzuDragon/rotary-screen-customization';

declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

/** Dates are shown in the viewer's own timezone, not UTC. */
function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
}

const localDate = (epochSeconds: number): string =>
  new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

/** Build stamp, so it is obvious whether a hard reload picked up a new deploy. */
function buildFooter() {
  return el(
    'p',
    { class: 'muted center foot' },
    el('a', { href: REPO_URL, target: '_blank', rel: 'noreferrer' }, 'source on GitHub'),
    ' · ',
    el(
      'a',
      {
        href: `${REPO_URL}/commit/${__BUILD_SHA__}`,
        target: '_blank',
        rel: 'noreferrer',
        title: `built ${localTime(__BUILD_TIME__)}`,
      },
      `site build ${__BUILD_SHA__}`,
    ),
    ` · ${localTime(__BUILD_TIME__)}`,
  );
}

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


/**
 * Wi-Fi card. Also the setup step.
 *
 * First-time provisioning and changing networks were separate screens with the
 * same three fields, which is what made changing a network feel like starting
 * over. They are one control now: an unlinked dial gets the form directly, a
 * linked one gets it behind "Change network".
 *
 * Credentials only ever travel over USB, deliberately -- pushing them through
 * the service would mean a wrong password leaves the dial off the network and
 * out of reach of the one channel that could fix it. The cable itself is opened
 * from the bar at the top; this card never opens or closes it.
 */
function wifiCard(ctx: PageContext) {
  const heading = el('h2', {}, 'Wi-Fi');
  const current = el('div', { class: 'status' });
  const blurb = el('p', { class: 'muted' });
  const changeBtn = el('button', { class: 'ghost' }, 'Change network') as HTMLButtonElement;

  const select = el('select', { class: 'input' }) as HTMLSelectElement;
  const password = el('input', {
    class: 'input',
    type: 'password',
    placeholder: 'Wi-Fi password',
  }) as HTMLInputElement;
  const go = el('button', { class: 'primary' }, 'Join this network') as HTMLButtonElement;
  const cancel = el('button', { class: 'ghost' }, 'Cancel') as HTMLButtonElement;
  const status = el('div', { class: 'status' });
  const form = el(
    'div',
    {},
    el('label', { class: 'lbl' }, 'Network'),
    select,
    el('label', { class: 'lbl' }, 'Password'),
    password,
    go,
    el('div', { class: 'row' }, cancel),
    status,
  );
  form.hidden = true;

  let manual: HTMLInputElement | null = null;
  let scannedFor: Connection | null = null;
  const chosenSsid = () => (manual ? manual.value.trim() : select.value);

  /** Setup mode: a dial is on the cable but this page is not linked to one. */
  const setupMode = () => Boolean(!ctx.session && liveConnection()?.responsive);

  const loadNetworks = async (conn: Connection) => {
    if (scannedFor === conn) return;
    scannedFor = conn;
    select.replaceChildren(el('option', { value: '' }, 'Scanning…'));
    try {
      const ssids = await conn.improv.scan();
      if (ssids.length === 0) throw new Error('no networks reported');
      select.replaceChildren(
        ...ssids.map((s) =>
          el('option', { value: s.name }, `${s.name}${s.secured ? '' : ' (open)'}  ·  ${s.rssi}dBm`),
        ),
      );
    } catch {
      // A dial that cannot scan can still be told. Same fallback as before.
      manual = el('input', { class: 'input', placeholder: 'Network name' }) as HTMLInputElement;
      select.replaceWith(manual);
    }
  };

  const paint = () => {
    const conn = liveConnection();

    if (setupMode()) {
      heading.textContent = 'Set up Wi-Fi';
      current.replaceChildren(
        note('This dial has no network yet. Pick one and it will link itself to this page.'),
      );
      blurb.textContent =
        'The password goes straight down the cable — it never touches the internet.';
      changeBtn.hidden = true;
      form.hidden = false;
      cancel.hidden = true;
      void loadNetworks(conn!);
      return;
    }

    heading.textContent = 'Wi-Fi';
    cancel.hidden = false;
    const ssid = ctx.status?.wifiSsid;
    const rssi = ctx.status?.wifiRssi;
    current.replaceChildren(
      !ctx.session
        ? note('Link a dial to see which network it is on.')
        : ssid
          ? note(`On ${ssid}${typeof rssi === 'number' ? ` · ${rssi} dBm` : ''}.`, 'ok')
          : note('The dial has not reported a network yet. It reports one each time it checks in.'),
    );
    blurb.textContent = !conn
      ? 'Changing networks needs the cable, since the password never goes through the ' +
        'internet. Connect over USB at the top of the page.'
      : conn.responsive
        ? 'Changing networks keeps everything else — the dial keeps its identity and settings.'
        : 'The dial is not answering over the cable, so it cannot be told about a network. ' +
          'Reflashing below is the usual way back.';
    changeBtn.hidden = !ctx.session;
    changeBtn.disabled = !conn?.responsive;
    if (!conn?.responsive) {
      form.hidden = true;
      scannedFor = null;
    }
  };

  changeBtn.onclick = async () => {
    const conn = liveConnection();
    if (!conn) return;
    form.hidden = false;
    changeBtn.disabled = true;
    status.replaceChildren(note('Asking the dial what it can see…'));
    await loadNetworks(conn);
    status.replaceChildren(note('Pick the network the dial should join.'));
  };

  cancel.onclick = () => {
    form.hidden = true;
    changeBtn.disabled = false;
    status.replaceChildren();
  };

  go.onclick = async () => {
    const conn = liveConnection();
    if (!conn) {
      status.replaceChildren(note('The cable came out — reconnect at the top.', 'err'));
      return;
    }
    const ssid = chosenSsid();
    if (!ssid) {
      status.replaceChildren(note('Pick a network first.', 'err'));
      return;
    }
    go.disabled = true;
    status.replaceChildren(note(`Joining ${ssid}…`));
    try {
      const next = await provision(conn, ssid, password.value);
      password.value = '';

      // A dial that just joined hands back its own settings URL. With no
      // session that link is the whole setup step; with one it is how we tell
      // whether the cable is even in the dial this page is editing.
      const linked = next ? parseSession(next) : null;
      if (!ctx.session && linked) {
        adoptSession(next!);
        ctx.relink(linked);
        return;
      }

      form.hidden = true;
      changeBtn.disabled = false;
      status.replaceChildren();
      const elsewhere = Boolean(linked && ctx.session && linked.id !== ctx.session.id);
      current.replaceChildren(
        note(
          elsewhere
            ? `Joined ${ssid}, but the cable is in dial ${linked!.id}, not this one.`
            : `Joined ${ssid}. Settings and history are unchanged.`,
          elsewhere ? 'info' : 'ok',
        ),
      );
      // Confirm from the dial rather than assuming: it reports its network on
      // the next poll, so make that poll happen now.
      await conn.improv.refresh().catch(() => null);
      await ctx.refreshStatus();
    } catch (err) {
      status.replaceChildren(
        note(
          `${err instanceof Error ? err.message : String(err)} — the dial went back to ` +
            'the network it was on.',
          'err',
        ),
      );
    }
    go.disabled = false;
  };

  paint();
  ctx.onChange(paint);

  return el('section', { class: 'card' }, heading, current, blurb, changeBtn, form);
}

/**
 * Firmware card. Works with or without a session.
 *
 * Flashing needs Web Serial and nothing else -- not Improv, not a device
 * identity. Gating it behind provisioning created a dead end: a device that
 * could not be provisioned also could not be reflashed, which is exactly when
 * you most need to. Only publishing your own build requires a session, since
 * that writes to shared storage.
 */
function firmwareCard(session: api.Session | null) {
  const fwSelect = el('select', { class: 'input' }) as HTMLSelectElement;
  const fwStatus = el('div', { class: 'status' });
  const fwBar = el('div', { class: 'bar-fill' });
  const fwBarWrap = el('div', { class: 'bar' }, fwBar);
  fwBarWrap.hidden = true;
  const fwLog = el('pre', { class: 'log' });
  const fwLogBox = el('details', { class: 'adv' }, el('summary', {}, 'Flashing log'), fwLog);
  const flashBtn = el('button', { class: 'primary' }, 'Flash over USB');
  const eraseBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const eraseRow = el(
    'label',
    { class: 'row' },
    eraseBox,
    el('span', {}, 'Also erase saved Wi-Fi and device identity (factory reset)'),
  );
  const fwFile = el('input', { type: 'file', accept: '.bin', class: 'input' }) as HTMLInputElement;
  const fwUpload = el('button', { class: 'ghost' }, 'Publish this file');

  let runningVersion: string | null = null;
  let fwIndex: api.FirmwareIndex | null = null;

  /*
   * Flashing is a cable job, and the card says so -- but it never *requires*
   * the shared connection.
   *
   * That connection only exists if the dial answered Improv, and a dial too
   * broken to answer is exactly the one that needs reflashing. So a live
   * connection is used when there is one (no second port prompt for a device
   * the page is already showing as connected), and picking the port by hand
   * stays available when there is not.
   */
  const cableNote = el('p', { class: 'muted' });
  const paintCable = () => {
    const conn = liveConnection();
    cableNote.textContent = !serialSupported()
      ? 'Flashing needs Web Serial — use desktop Chrome, Edge, or Opera.'
      : conn
        ? conn.responsive
          ? 'Cable attached — flashing will use it, and the dial comes back on its own.'
          : 'Cable attached. The dial is not answering, which is exactly what flashing fixes.'
        : 'Flashing goes over the cable, never the network. Connect over USB at the top ' +
          'of the page first.';
    // The port is picked once, in the bar. Offering a second way in here is
    // what made it unclear which button connects what.
    flashBtn.disabled = !liveConnection() || fwSelect.value === '';
  };
  paintCable();
  onConnectionChange(paintCable);

  const logLine = (line: string) => {
    fwLog.textContent = `${(fwLog.textContent ?? '') + line}`.slice(-8000);
    fwLog.scrollTop = fwLog.scrollHeight;
  };

  const paint = async () => {
    try {
      // Without a session we can still read the public firmware list; we just
      // cannot know which version the device is running.
      let index: api.FirmwareIndex | null;
      if (session) {
        const status = await api.getStatus(session);
        runningVersion = status.device?.fwVersion ?? null;
        index = status.firmware;
      } else {
        index = await api.listFirmware(session);
      }
      fwIndex = index;

      const versions = index?.versions ?? [];
      if (versions.length === 0) {
        fwSelect.replaceChildren(el('option', { value: '' }, 'nothing published yet'));
        flashBtn.disabled = true;
        fwStatus.replaceChildren(note('No builds published yet.'));
        return;
      }

      const keep = fwSelect.value;
      fwSelect.replaceChildren(
        ...versions.map((v) => {
          const when = localDate(v.uploadedAt);
          const tags = [
            v.version === index?.latest ? 'latest' : '',
            v.version === runningVersion ? 'installed' : '',
            v.source,
          ].filter(Boolean);
          return el('option', { value: v.version }, `${v.version} — ${when} (${tags.join(', ')})`);
        }),
      );
      fwSelect.value = keep && versions.some((v) => v.version === keep) ? keep : index!.latest;

      if (!session) {
        fwStatus.replaceChildren(note(`Latest is ${index?.latest}. Pick a version and flash.`));
      } else {
        const running = runningVersion ?? 'unknown';
        const upToDate = runningVersion === index?.latest;
        fwStatus.replaceChildren(
          note(
            `Running ${running} · latest ${index?.latest}` +
              (upToDate ? ' — up to date.' : ' — a newer build is available.'),
            upToDate ? 'ok' : 'info',
          ),
        );
      }
    } catch (err) {
      fwStatus.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
    }
    paintCable();
  };
  void paint();

  flashBtn.onclick = async () => {
    const version = fwSelect.value;
    if (!version) return;
    flashBtn.disabled = true;
    fwLog.textContent = '';
    fwLogBox.open = true;
    fwBarWrap.hidden = false;
    fwBar.style.width = '0%';
    fwStatus.replaceChildren(note(`Downloading ${version}…`));

    try {
      const chosen = fwIndex?.versions.find((v) => v.version === version);
      const image = await api.fetchFirmware(version, chosen?.sha256);
      logLine(`downloaded ${version} (${image.byteLength} bytes)\n`);

      // esptool needs the port to itself. If the settings page is holding it
      // esptool needs the port to itself and at its own baud rate. Take the
      // one already open rather than closing it and asking again: prompting
      // for a device the page is currently showing as connected is a poor way
      // to start something destructive.
      const held = await takePort();
      if (!held) throw new Error('The cable is no longer connected — reconnect at the top.');
      logLine('using the cable connected at the top of the page\n');
      fwStatus.replaceChildren(note('Keep it plugged in…'));

      await flashFirmware(
        image,
        {
          log: logLine,
          progress: (f) => {
            fwBar.style.width = `${Math.round(f * 100)}%`;
            fwStatus.replaceChildren(note(`Writing… ${Math.round(f * 100)}%`));
          },
        },
        { eraseNvs: eraseBox.checked },
        held,
      );

      fwBar.style.width = '100%';
      fwStatus.replaceChildren(
        note(
          eraseBox.checked
            ? 'Flashed and reset. The device restarted with no Wi-Fi saved — set it up again below.'
            : 'Flashed. The device is restarting — Wi-Fi settings were kept.',
          'ok',
        ),
      );
      setTimeout(() => void paint(), 12000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logLine(`\nFAILED: ${msg}\n`);
      fwStatus.replaceChildren(
        note(`${msg} — the device may need flashing again before it boots.`, 'err'),
      );
    }
    // takePort() ended the shared connection, so re-derive the gate rather
    // than just enabling the button: the cable now needs reconnecting.
    paintCable();
  };

  fwUpload.onclick = async () => {
    if (!session) return;
    const file = fwFile.files?.[0];
    if (!file) {
      fwStatus.replaceChildren(note('Choose a merged .bin first.', 'err'));
      return;
    }
    fwUpload.disabled = true;
    fwStatus.replaceChildren(note(`Uploading ${(file.size / 1024).toFixed(0)} KB…`));
    try {
      await api.uploadFirmware(session, file);
      await paint();
    } catch (err) {
      fwStatus.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
    }
    fwUpload.disabled = false;
  };

  const children: (Node | string)[] = [
    el('h2', {}, 'Firmware'),
    el(
      'p',
      { class: 'warn' },
      'Flashing replaces the software on the device over USB. Keep it plugged in ' +
        'until it finishes. If a flash fails the device may not boot until you ' +
        'flash it again. Wi-Fi credentials are preserved — the flasher skips the ' +
        'region they live in.',
    ),
    cableNote,
    el('label', { class: 'lbl' }, 'Version'),
    fwSelect,
    eraseRow,
    flashBtn,
    fwBarWrap,
    fwStatus,
    fwLogBox,
  ];
  if (session) {
    children.push(
      el(
        'details',
        { class: 'adv' },
        el('summary', {}, 'Publish your own build'),
        el(
          'p',
          { class: 'muted' },
          'A merged image starting at offset 0 — the firmware workflow produces one, ' +
            'or build locally and merge with esptool.',
        ),
        fwFile,
        fwUpload,
      ),
    );
  }
  return el('section', { class: 'card' }, ...children);
}

/* ------------------------------ device bar ------------------------------ */

/** What this render is looking at. See the note where it is built. */
interface PageContext {
  session: api.Session | null;
  readonly config: DeviceConfig;
  readonly status: api.DeviceState | null;
  /** Re-render the whole page against a different dial, or none. */
  relink: (next: api.Session | null) => void;
  /** Called whenever the cable or the device status changes. */
  onChange: (fn: () => void) => void;
  refreshStatus: () => Promise<void>;
}

const shortAgo = (epochSeconds: number): string => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

/**
 * The one place that answers "which dial is this page editing, and is the
 * cable in that one?".
 *
 * Every other card reads this state and never opens or closes the port itself.
 * Three cards each owning their own connect button meant they disagreed the
 * moment any one of them acted -- and none of them ever named the device, so
 * the page was editing an id it never showed you.
 */
function deviceBar(ctx: PageContext) {
  const dot = el('span', { class: 'dot' });
  const title = el('div', { class: 'devbar-title' });
  const detail = el('div', { class: 'devbar-detail' });
  const action = el('button', { class: 'ghost' }, 'Connect over USB') as HTMLButtonElement;
  const extra = el('button', { class: 'ghost' }, 'Switch') as HTMLButtonElement;
  const status = el('div', { class: 'status' });

  /** Device the cable is in, when it is provisioned enough to say. */
  const attachedId = () => {
    const conn = liveConnection();
    return conn?.nextUrl ? (parseSession(conn.nextUrl)?.id ?? null) : null;
  };

  const paint = () => {
    const conn = liveConnection();
    const attached = attachedId();
    const session = ctx.session;
    const mismatch = Boolean(session && attached && attached !== session.id);

    const tone = conn
      ? mismatch || !conn.responsive
        ? 'dot-warn'
        : 'dot-ok'
      : session
        ? 'dot-idle'
        : 'dot-off';
    dot.className = `dot ${tone}`;
    extra.hidden = !mismatch;
    action.textContent = conn ? 'Disconnect' : 'Connect over USB';
    action.disabled = !serialSupported();

    if (conn && !conn.responsive) {
      title.textContent = 'Cable attached — no answer';
      detail.textContent =
        'The port is open but the dial is not talking. Flashing still works; ' +
        'setting up Wi-Fi does not.';
      status.replaceChildren();
      return;
    }

    if (!session) {
      title.textContent = conn ? 'Dial attached, not set up yet' : 'No dial linked yet';
      detail.textContent = conn
        ? `${conn.info.firmware} ${conn.info.version} — give it a Wi-Fi network below.`
        : 'Plug a dial in over USB to set it up. Everything below is a preview until then.';
      status.replaceChildren();
      return;
    }

    title.textContent = `Dial ${session.id}`;
    if (mismatch) {
      extra.textContent = `Switch to ${attached}`;
      detail.textContent = `The cable is in dial ${attached}, not this one.`;
    } else {
      const bits = [ctx.config.login];
      if (ctx.status?.lastSeen) bits.push(`seen ${shortAgo(ctx.status.lastSeen)}`);
      if (ctx.status?.wifiSsid) bits.push(`on ${ctx.status.wifiSsid}`);
      if (conn) bits.push('cable attached');
      detail.textContent = bits.join(' · ');
    }
  };

  action.onclick = async () => {
    action.disabled = true;
    if (liveConnection()) {
      await closeShared();
      status.replaceChildren();
      return;
    }
    status.replaceChildren(note('Waiting for you to pick a port…'));
    try {
      const conn = await openShared((msg) => status.replaceChildren(note(msg)));
      status.replaceChildren();
      // A provisioned dial hands back its own settings URL. With no session
      // yet that is the link, so setting one up needs no second step.
      if (!ctx.session && conn.nextUrl) {
        const adopted = adoptSession(conn.nextUrl);
        if (adopted) {
          void ctx.relink(adopted);
          return;
        }
      }
    } catch (err) {
      status.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
    }
    paint();
  };

  extra.onclick = () => {
    const conn = liveConnection();
    const next = conn?.nextUrl ? adoptSession(conn.nextUrl) : null;
    if (next) void ctx.relink(next);
  };

  if (!serialSupported()) {
    status.replaceChildren(
      note(
        'This browser has no Web Serial, so setup and flashing need desktop Chrome, ' +
          'Edge, or Opera. On Linux you may also need to be in the "dialout" group.',
        'info',
      ),
    );
  }

  paint();
  ctx.onChange(paint);

  const node = el(
    'section',
    { class: 'card devbar' },
    el(
      'div',
      { class: 'devbar-row' },
      dot,
      el('div', { class: 'devbar-text' }, title, detail),
      el('div', { class: 'devbar-actions' }, extra, action),
    ),
    status,
  );
  // The bar's height varies with its message, and the sticky push card has to
  // sit just below it rather than on top of it.
  new ResizeObserver(() =>
    document.documentElement.style.setProperty('--devbar-h', `${node.offsetHeight}px`),
  ).observe(node);
  return node;
}

/* -------------------------------- config -------------------------------- */

/** Torn down and replaced on every render -- see where it is set. */
let unsubscribeConnection: (() => void) | null = null;

/**
 * Overlay an unsaved config onto the last payload, so the preview reflects
 * edits immediately without a round trip.
 */
function applyDraft(payload: DevicePayload | null, draft: DeviceConfig): DevicePayload | null {
  if (!payload) return null;
  const repos =
    draft.repos === null
      ? payload.repos
      : draft.repos
          .map((name) => payload.repos.find((r) => r.n === name))
          .filter((r): r is NonNullable<typeof r> => Boolean(r));
  return { ...payload, decks: draft.decks, theme: draft.theme, repos };
}

function previewPanel(getPayload: () => DevicePayload | null) {
  const canvas = el('canvas', { class: 'screen', width: String(SIZE), height: String(SIZE) });
  const ctx = canvas.getContext('2d')!;
  const caption = el('p', { class: 'muted center' }, '');
  let cards: Card[] = [];
  let cursor = 0;

  const draw = () => {
    const p = getPayload();
    if (!p) return;
    cards = buildCards(p);
    if (cursor >= cards.length) cursor = 0;
    render(ctx, p, cards, cursor);
    const deck = cards[cursor]?.deck ?? 'summary';
    caption.textContent = `${DECK_LABEL[deck]} — scroll to turn the knob, click to press it`;
  };

  // Mirrors the device exactly: turning scrolls one flat list end to end, and
  // pressing jumps to the head of the next section. There is no touch input.
  canvas.onwheel = (e) => {
    e.preventDefault();
    if (cards.length === 0) return;
    cursor = (cursor + (e.deltaY > 0 ? 1 : -1) + cards.length) % cards.length;
    draw();
  };
  canvas.onclick = () => {
    if (cards.length === 0) return;
    cursor = nextSection(cards, cursor);
    draw();
  };

  return { node: el('div', { class: 'preview' }, canvas, caption), draw };
}

/**
 * The whole site, in one page.
 *
 * There used to be a landing screen, a provisioning screen and a settings
 * screen. Nothing about a dial is worth its own navigation step -- the device
 * either has a link to this page or it does not -- and splitting it meant you
 * could not see what the thing did until after you had set one up. Now the
 * settings render either way, disabled and showing sample data until a dial is
 * linked, and provisioning is just the Wi-Fi card doing its job.
 */
async function page(session: api.Session | null) {
  subtitle.textContent = session ? 'Settings' : 'Preview — connect a dial to make it yours';
  show(el('section', { class: 'card' }, note('Loading…')));

  let config: DeviceConfig = DEMO_CONFIG;
  let payload: DevicePayload | null = session ? null : demoPayload();
  let status: api.DeviceState | null = null;

  if (session) {
    try {
      config = await api.getConfig(session);
      payload = await api.getPreview(session).catch(() => null);
      status = await api.getStatus(session).then((s) => s.device).catch(() => null);
    } catch (err) {
      const retry = el('button', { class: 'ghost' }, 'Forget this dial');
      retry.onclick = () => {
        api.clearSession();
        void page(null);
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
  }
  // Wear the dial's colour from the first paint, not from the first edit.
  applyAccent(config.theme.accent);

  const preview = previewPanel(() => applyDraft(payload, draft));

  // Edits accumulate in a draft and only reach the device when pushed.
  //
  // Auto-saving on every checkbox meant a KV write per click -- against a
  // 1000/day account-wide cap -- and a confusing wait while each one
  // propagated. Batching means one write per push, and the preview updates
  // instantly because it renders the draft locally.
  let draft: DeviceConfig = structuredClone(config);
  const pushNote = el('div', { class: 'status savebar' });
  const pushBtn = el('button', { class: 'primary' }, 'Push to device') as HTMLButtonElement;

  /*
   * USB is a shortcut, never a requirement.
   *
   * Settings live in the service and the dial picks them up on its next poll,
   * so a push always works. When the cable is in, the browser can tell the
   * device to fetch right now -- which turns "up to a minute, then probably"
   * into "done, and here is the confirmation from the device".
   *
   * The cable itself is connected from the bar at the top of the page. This
   * card only reports what that means for pushing.
   */
  const pushHint = el('div', { class: 'status' });

  const paintHint = (msg?: string, tone?: 'ok' | 'info' | 'err') => {
    if (msg) {
      pushHint.replaceChildren(note(msg, tone));
      return;
    }
    // "Within about a minute" is only true of a dial that is actually checking
    // in. last_seen is written at most every 15 minutes, so only a much older
    // stamp than that means anything -- hence 30.
    const seen = status?.lastSeen ?? 0;
    const quiet = Boolean(session && seen && Date.now() / 1000 - seen > 1800);

    pushHint.replaceChildren(
      note(
        !serialSupported()
          ? 'This browser has no Web Serial, so pushes arrive at the dial’s next poll.'
          : liveConnection()
            ? 'Cable attached — pushes apply instantly.'
            : quiet
              ? `The dial has not checked in since ${shortAgo(seen)}. A push is saved either ` +
                'way and reaches it when it is next online.'
              : 'Pushes reach the dial at its next check-in, within about a minute. ' +
                'Connect over USB above to apply them instantly.',
        liveConnection() ? 'ok' : 'info',
      ),
    );
  };
  paintHint();
  onConnectionChange(() => paintHint());

  /**
   * Ask the device to fetch now. Returns true only if it confirms it has the
   * new settings -- anything else falls back to watching the service, which is
   * what happens with no cable attached anyway.
   */
  const nudgeOverUsb = async (): Promise<boolean> => {
    const conn = liveConnection();
    if (!conn) return false;
    try {
      const ok = await conn.improv.refresh();
      if (ok === null) {
        paintHint('Cable attached, but this firmware predates instant push — flash a newer build.', 'info');
        return false;
      }
      if (!ok) {
        paintHint('The dial could not reach the service just now.', 'err');
        return false;
      }
      paintHint();
      return true;
    } catch (err) {
      // Usually the cable came out. Drop the stale connection so the bar and
      // every other card stop claiming a link that is gone.
      await closeShared();
      paintHint(err instanceof Error ? err.message : String(err), 'err');
      return false;
    }
  };

  /* theme -- declared here because refreshDirty below drives the reset button */
  const accent = el('input', { type: 'color', class: 'swatch' }) as HTMLInputElement;
  accent.value = config.theme.accent;
  accent.oninput = () => edit({ theme: { ...draft.theme, accent: accent.value } });

  // A native colour picker has no way back to where you started, and the
  // default is not a colour anyone would find again by eye.
  const accentReset = el('button', { class: 'ghost' }, 'Reset') as HTMLButtonElement;
  accentReset.onclick = () => {
    accent.value = DEFAULT_ACCENT;
    edit({ theme: { ...draft.theme, accent: DEFAULT_ACCENT } });
  };
  const accentRow = el('div', { class: 'swatch-row' }, accent, accentReset);

  // Driven by refreshDirty, so declared up here with the others it drives.
  const pushCard = el('section', { class: 'card push-card' }, pushBtn, pushNote, pushHint);

  const dirty = () => JSON.stringify({ ...draft, updatedAt: 0 }) !== JSON.stringify({ ...config, updatedAt: 0 });

  const refreshDirty = () => {
    // The page wears the colour being edited, not the one last pushed: the
    // point is to see the choice, and the preview alone is 240px of it.
    applyAccent(draft.theme.accent);
    accentReset.disabled = draft.theme.accent.toLowerCase() === DEFAULT_ACCENT.toLowerCase();
    pushBtn.disabled = !dirty();
    pushNote.replaceChildren(
      dirty()
        ? note('Unsaved changes — push to send them to the dial.')
        : note('The dial matches these settings.', 'ok'),
    );
    pushCard.classList.toggle('dirty', dirty());

    preview.draw();
  };

  const edit = (patch: Partial<DeviceConfig>) => {
    draft = { ...draft, ...patch };
    refreshDirty();
  };

  pushBtn.onclick = async () => {
    if (!session) return;
    pushBtn.disabled = true;
    pushNote.replaceChildren(note('Pushing…'));
    try {
      config = await api.putConfig(session, draft);
      draft = structuredClone(config);
    } catch (err) {
      pushNote.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
      pushBtn.disabled = false;
      return;
    }

    // With the cable in, ask the device to fetch now and report back. That
    // reply comes from the device itself, so it is the only confirmation here
    // that is actually about the dial rather than about the service.
    if (liveConnection()) {
      pushNote.replaceChildren(note('Pushed — telling the device over USB…'));
      if (await nudgeOverUsb()) {
        payload = (await api.getPreview(session).catch(() => null)) ?? payload;
        pushNote.replaceChildren(note('Live on the dial.', 'ok'));
        refreshDirty();
        return;
      }
    }

    /*
     * Otherwise wait for the dial itself to say it has them.
     *
     * This used to re-read the service's own payload, which only proved the
     * write had landed -- a claim about the service, dressed up as a claim
     * about the device. The dial now echoes back the config.updatedAt it is
     * showing, so this is the real thing: when configApplied catches up to
     * what we just saved, the settings on screen are the settings on the dial.
     */
    pushNote.replaceChildren(note('Saved — waiting for the dial to pick it up…'));
    payload = (await api.getPreview(session).catch(() => null)) ?? payload;
    preview.draw();

    const deadline = Date.now() + 150000;
    for (;;) {
      const fresh = await api
        .getStatus(session)
        .then((r) => r.device)
        .catch(() => null);
      if (fresh) status = fresh;
      if (fresh && (fresh.configApplied ?? 0) >= config.updatedAt) {
        pushNote.replaceChildren(note('Live on the dial.', 'ok'));
        break;
      }
      if (Date.now() > deadline) {
        // Not an error: the write is durable and the dial will apply it when it
        // next checks in. Only the confirmation timed out.
        pushNote.replaceChildren(
          note('Saved. The dial has not checked in yet — it will apply these when it does.'),
        );
        break;
      }
      await new Promise((r) => setTimeout(r, 4000));
    }
    notifyBar();
    refreshDirty();
  };

  /* deck toggles */
  const deckList = el('div', { class: 'rows' });
  for (const id of Object.keys(DECK_LABEL) as DeckId[]) {
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = draft.decks.includes(id);
    cb.onchange = async () => {
      const next = (Object.keys(DECK_LABEL) as DeckId[]).filter((d) =>
        d === id ? cb.checked : draft.decks.includes(d),
      );
      if (next.length === 0) {
        cb.checked = true;
        return;
      }
      edit({ decks: next });
    };
    deckList.append(el('label', { class: 'row' }, cb, el('span', {}, DECK_LABEL[id])));
  }

  /* whose GitHub to show */
  const loginInput = el('input', {
    class: 'input',
    placeholder: 'github username',
    autocomplete: 'off',
  }) as HTMLInputElement;
  loginInput.value = draft.login;
  /*
   * Switching account is its own action, like connecting a token -- not part
   * of the Push draft.
   *
   * As a draft field it was the one setting people expected to take effect
   * when they committed to it, and it could not sit in a draft honestly: the
   * repo list, the preview and the repo order all belong to one account, so a
   * pending name left the page showing one account's data under another's.
   */
  const loginBtn = el('button', { class: 'primary' }, 'Switch account') as HTMLButtonElement;
  const loginStatus = el('div', { class: 'status' });

  const paintLogin = (msg?: string, tone?: 'ok' | 'info' | 'err') => {
    const v = loginInput.value.trim();
    const valid = /^[\w-]{1,39}$/.test(v);
    const same = v.toLowerCase() === config.login.toLowerCase();
    loginBtn.disabled = !valid || same;
    loginStatus.replaceChildren(
      note(
        msg ??
          (!v
            ? 'Enter a GitHub username.'
            : !valid
              ? 'That is not a valid GitHub username.'
              : same
                ? `This dial shows @${config.login}.`
                : `Switch to show @${v} instead of @${config.login}.`),
        tone ?? (v && !valid ? 'err' : same ? 'ok' : 'info'),
      ),
    );
  };
  paintLogin();
  loginInput.oninput = () => paintLogin();
  loginInput.onkeydown = (ev) => {
    if (ev.key === 'Enter' && !loginBtn.disabled) loginBtn.click();
  };

  loginBtn.onclick = async () => {
    if (!session) return;
    const v = loginInput.value.trim();
    loginBtn.disabled = true;
    loginStatus.replaceChildren(note(`Looking up @${v}…`));
    try {
      // Only the account, and a fresh repo selection since the old names belong
      // to the previous account. Anything else unsaved stays in the Push draft.
      const saved = await api.putConfig(session, { login: v, repos: null });
      config = saved;
      draft = { ...draft, login: saved.login, repos: null, updatedAt: saved.updatedAt };
    } catch (err) {
      // Includes "There is no GitHub user called ..." -- the worker looks the
      // account up before saving it.
      paintLogin(err instanceof Error ? err.message : String(err), 'err');
      loginBtn.disabled = false;
      return;
    }

    // The account was resolved before it was saved, so its repos and stats
    // exist now. Swap them in rather than leaving the old account's on screen.
    allRepos = await api
      .getRepos(session)
      .then((r) => r.repos.map((x) => ({ name: x.name, stars: x.stars })))
      .catch(() => []);
    renderRepos();
    payload = (await api.getPreview(session).catch(() => null)) ?? payload;
    refreshDirty();
    notifyBar();

    const instant = await nudgeOverUsb();
    paintLogin(
      instant
        ? `Now showing @${config.login} on the dial.`
        : `Switched to @${config.login}. The dial changes over within about a minute.`,
      'ok',
    );
  };

  /*
   * Repo picker: which cards the dial shows, and in what order.
   *
   * The dial holds MAX_DEVICE_REPOS of them -- a fixed array in the firmware --
   * and used to simply drop the rest on arrival, so picking twelve silently
   * showed eight with no way to say which eight. The cap is a visible part of
   * the control now.
   *
   * `repos: null` is the automatic mode: the most-starred, re-evaluated every
   * refresh, so a new repo that takes off appears without anyone touching this
   * page. That used to be an invisible default you lost by clicking anything;
   * it is a checkbox now, and turning it off freezes the current list.
   */
  const autoBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const autoRow = el(
    'label',
    { class: 'row' },
    autoBox,
    el('span', {}, `Keep the top ${MAX_DEVICE_REPOS} automatically`),
  );
  const repoCount = el('div', { class: 'status' });
  const repoList = el('div', {}, note('Loading repos…'));
  let allRepos: { name: string; stars: number }[] = [];

  /** Names in display order. Derived from the top of the list while automatic. */
  const chosen = (): string[] =>
    draft.repos ?? allRepos.slice(0, MAX_DEVICE_REPOS).map((r) => r.name);

  const setChosen = (names: string[] | null) => {
    edit({ repos: names === null ? null : names.slice(0, MAX_DEVICE_REPOS) });
    renderRepos();
  };

  autoBox.onchange = () => setChosen(autoBox.checked ? null : chosen());

  let dragging: string | null = null;

  function renderRepos() {
    autoBox.checked = draft.repos === null;

    if (allRepos.length === 0) {
      repoCount.replaceChildren();
      repoList.replaceChildren(note('This account has no repos to show.'));
      return;
    }

    const auto = draft.repos === null;
    const picked = chosen();
    const rest = allRepos.filter((r) => !picked.includes(r.name));

    repoCount.replaceChildren(
      note(
        auto
          ? `Showing the ${Math.min(picked.length, MAX_DEVICE_REPOS)} most-starred, updated as ` +
            'repos come and go. Untick above to choose and order them yourself.'
          : `${picked.length} of ${MAX_DEVICE_REPOS} — drag to reorder. The dial shows them ` +
            'in this order.',
        auto ? 'info' : 'ok',
      ),
    );

    const row = (name: string, stars: number, isPicked: boolean) => {
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = isPicked;
      cb.disabled = auto || (!isPicked && picked.length >= MAX_DEVICE_REPOS);
      cb.onchange = () =>
        setChosen(isPicked ? picked.filter((n) => n !== name) : [...picked, name]);

      const r = el(
        'div',
        { class: `repo-row ${isPicked ? 'pick' : 'unpick'}` },
        el(
          'label',
          { class: 'repo-main' },
          cb,
          el('span', { class: 'repo-name' }, name),
          el('span', { class: 'tag' }, `★ ${stars}`),
        ),
      );

      // Only chosen rows drag, and only when the order is ours to set: there is
      // nothing to order in automatic mode, and nothing to order among the ones
      // that are not shown.
      if (isPicked && !auto && picked.length > 1) {
        const grip = el('span', { class: 'grip', title: 'Drag to reorder' }, '⠿');
        r.append(grip);
        r.draggable = true;
        r.ondragstart = (ev) => {
          dragging = name;
          r.classList.add('dragging');
          ev.dataTransfer?.setData('text/plain', name);
          if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
        };
        r.ondragend = () => {
          dragging = null;
          r.classList.remove('dragging');
          clearMarkers();
        };
        r.ondragover = (ev) => {
          if (!dragging || dragging === name) return;
          ev.preventDefault();
          // Which half of the row the pointer is over decides whether the line
          // is drawn above or below it -- the drop lands where the line is.
          const box = r.getBoundingClientRect();
          const above = ev.clientY - box.top < box.height / 2;
          clearMarkers();
          r.classList.add(above ? 'drop-above' : 'drop-below');
        };
        r.ondragleave = () => r.classList.remove('drop-above', 'drop-below');
        r.ondrop = (ev) => {
          ev.preventDefault();
          if (!dragging || dragging === name) return;
          const above = r.classList.contains('drop-above');
          clearMarkers();
          const next = picked.filter((n) => n !== dragging);
          const at = next.indexOf(name);
          next.splice(above ? at : at + 1, 0, dragging);
          setChosen(next);
        };
      }
      return r;
    };

    const clearMarkers = () => {
      for (const n of repoList.querySelectorAll('.drop-above, .drop-below')) {
        n.classList.remove('drop-above', 'drop-below');
      }
    };

    repoList.replaceChildren(
      ...picked.map((n) => {
        const meta = allRepos.find((r) => r.name === n);
        return row(n, meta?.stars ?? 0, true);
      }),
      ...(rest.length
        ? [el('div', { class: 'rows-divider' }, auto ? 'below the cut' : `not shown (${rest.length})`)]
        : []),
      ...rest.map((r) => row(r.name, r.stars, false)),
    );
  }

  if (!session) repoList.replaceChildren(note('Link a dial to choose which repos it shows.'));
  else
    api
      .getRepos(session)
      .then(({ repos }) => {
        allRepos = repos.map((r) => ({ name: r.name, stars: r.stars }));
        renderRepos();
      })
      .catch(() => repoList.replaceChildren(note('Could not load repos.', 'err')));

  const bright = el('input', {
    type: 'range',
    min: '5',
    max: '100',
    class: 'range',
  }) as HTMLInputElement;
  bright.value = String(config.theme.bright);
  const brightLabel = el('span', { class: 'tag' }, `${config.theme.bright}%`);
  // Update while dragging, save only on release, so a drag is one KV write.
  bright.oninput = () => {
    brightLabel.textContent = `${bright.value}%`;
  };
  bright.onchange = () => edit({ theme: { ...draft.theme, bright: Number(bright.value) } });

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
  rot.onchange = () => edit({ theme: { ...draft.theme, rotSec: Number(rot.value) } });


  /*
   * Whose GitHub access the dial uses.
   *
   * "Connect GitHub" signs in through a GitHub App: read-only permissions the
   * app declares and nobody can over-grant, and a token the server renews on its
   * own, so it never quietly lapses on a dial sitting on a desk. Pasting a
   * personal access token still works, one click further away, for anyone who
   * would rather not authorize an app -- and it is the only way in until the
   * app is registered, so it is shown open then.
   */
  const ghStatus = el('div', { class: 'status' });
  const ghConnect = el('button', { class: 'primary' }, 'Connect GitHub') as HTMLButtonElement;
  const ghDisconnect = el('button', { class: 'ghost' }, 'Disconnect') as HTMLButtonElement;
  const ghInstall = el('a', { target: '_blank', rel: 'noreferrer' }, 'Choose which private repos it can see');
  const ghInstallRow = el('p', { class: 'muted' }, ghInstall);

  const tokenInput = el('input', {
    class: 'input',
    type: 'password',
    placeholder: 'github_pat_...',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const tokenSave = el('button', { class: 'ghost' }, 'Use this token') as HTMLButtonElement;
  const tokenStatus = el('div', { class: 'status' });
  const patBox = el(
    'details',
    { class: 'adv' },
    el('summary', {}, 'Use a personal access token instead'),
    el(
      'p',
      { class: 'muted' },
      'Create one at ',
      el(
        'a',
        {
          href: 'https://github.com/settings/personal-access-tokens/new',
          target: '_blank',
          rel: 'noreferrer',
        },
        'github.com/settings/personal-access-tokens',
      ),
      ' with read-only access. It is encrypted at rest, checked against GitHub ' +
        'before being saved, and never sent to the device.',
    ),
    tokenInput,
    tokenSave,
    tokenStatus,
  ) as HTMLDetailsElement;

  let tokenState: api.TokenState | null = null;

  const paintGithub = (detail?: string, tone?: 'ok' | 'info' | 'err') => {
    const t = tokenState;
    const connected = Boolean(t?.present && !t.broken);
    const viaApp = t?.kind === 'app';
    ghConnect.hidden = !t?.app || (connected && viaApp);
    ghConnect.textContent = connected ? 'Connect GitHub instead' : 'Connect GitHub';
    ghDisconnect.hidden = !t?.present;
    ghInstallRow.hidden = !(viaApp && connected && t?.installUrl);
    if (t?.installUrl) ghInstall.setAttribute('href', t.installUrl);

    ghStatus.replaceChildren(
      note(
        detail ??
          (!t
            ? 'Checking…'
            : t.broken
              ? `Your ${t.kind === 'app' ? 'GitHub sign-in' : 'token'} stopped working — connect ` +
                (t.shared
                  ? 'again. Until then the dial shows public data only.'
                  : 'again for the dial to keep updating.')
              : !t.present
                ? t.shared
                  ? 'Not connected — the dial shows public data only.'
                  : 'Not connected — connect GitHub so the dial can fetch its stats.'
                : viaApp
                  ? `Connected as @${t.login}. The dial sees your public repos, plus any ` +
                    'private ones you choose.'
                  : `Using your personal token${t.login ? ` for @${t.login}` : ''} — ` +
                    'private repos included.'),
        tone ?? (t?.broken ? 'err' : t?.present ? 'ok' : 'info'),
      ),
    );
  };

  // Where a round trip through GitHub ended, carried back in the address bar.
  const outcome = githubOutcome;
  githubOutcome = null;
  const OUTCOME: Record<string, [string, 'info' | 'err']> = {
    denied: ['GitHub sign-in was cancelled.', 'info'],
    expired: ['That sign-in expired or started in another browser — try again from here.', 'err'],
    failed: ['GitHub sign-in did not complete — try again.', 'err'],
  };

  if (!session) {
    ghStatus.replaceChildren(note('Link a dial to connect GitHub.'));
  } else {
    paintGithub();
    api
      .tokenStatus(session)
      .then((t) => {
        tokenState = t;
        patBox.open = !t.app || t.kind === 'pat';
        const o = outcome ? OUTCOME[outcome] : undefined;
        paintGithub(o?.[0], o?.[1]);
      })
      .catch(() => ghStatus.replaceChildren(note('Could not read the GitHub connection.', 'err')));
  }

  ghConnect.onclick = async () => {
    if (!session) return;
    ghConnect.disabled = true;
    ghStatus.replaceChildren(note('Sending you to GitHub…'));
    try {
      const { url } = await api.startGithub(session);
      location.href = url; // comes back to /?github=<outcome>
    } catch (err) {
      paintGithub(err instanceof Error ? err.message : String(err), 'err');
      ghConnect.disabled = false;
    }
  };

  ghDisconnect.onclick = async () => {
    if (!session) return;
    ghDisconnect.disabled = true;
    try {
      await api.clearToken(session);
      tokenState = await api.tokenStatus(session);
      paintGithub(
        tokenState.shared
          ? 'Disconnected — the dial shows public data only.'
          : 'Disconnected. Connect GitHub again for the dial to keep updating.',
        'info',
      );
      payload = await api.getPreview(session).catch(() => payload);
      preview.draw();
    } catch (err) {
      paintGithub(err instanceof Error ? err.message : String(err), 'err');
    }
    ghDisconnect.disabled = false;
  };

  tokenSave.onclick = async () => {
    if (!session) return;
    const value = tokenInput.value.trim();
    if (!value) {
      tokenStatus.replaceChildren(note('Paste a token first.', 'err'));
      return;
    }
    tokenSave.disabled = true;
    tokenStatus.replaceChildren(note('Checking with GitHub…'));
    try {
      const { login } = await api.setToken(session, value);
      tokenInput.value = '';
      tokenStatus.replaceChildren(note(`Saved — connected as @${login}.`, 'ok'));
      tokenState = await api.tokenStatus(session);
      paintGithub();
      payload = await api.getPreview(session).catch(() => payload);
      preview.draw();
    } catch (err) {
      tokenStatus.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
    }
    tokenSave.disabled = false;
  };


  // Once a session is stored the app goes straight here, with no route back to
  // the USB flow. Clearing Chrome's serial permission does not help -- that is
  // a browser grant, this is app state -- so there has to be an explicit way
  // out, both to reconnect and to hand the device to someone else.
  const forgetBtn = el('button', { class: 'ghost' }, 'Forget this dial');
  forgetBtn.onclick = () => {
    api.clearSession();
    void page(null);
  };

  const refreshBtn = el('button', { class: 'ghost' }, 'Refresh from GitHub now');
  const refreshStatus = el('span', { class: 'tag' }, '');
  refreshBtn.onclick = async () => {
    if (!session) return;
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

  // Settle every derived control once, now that they all exist: the push
  // button starts disabled with "matches these settings" rather than inviting
  // a push of nothing, and a reload that restores form values is reconciled
  // against what the dial actually has.
  refreshDirty();

  /*
   * One object describing what this render is looking at, handed to the pieces
   * that need to agree about it. The bar and the Wi-Fi card both have to know
   * which dial is linked and whether the cable is in that one; before this they
   * each kept their own answer and drifted apart.
   */
  const barListeners = new Set<() => void>();
  const notifyBar = () => {
    for (const fn of [...barListeners]) fn();
  };
  // Each render subscribes afresh, so drop the previous one first. Without
  // this, relinking to another dial would leave the old page's listeners
  // repainting DOM that is no longer on screen.
  unsubscribeConnection?.();
  unsubscribeConnection = onConnectionChange(notifyBar);

  const pageCtx: PageContext = {
    session,
    get config() {
      return config;
    },
    get status() {
      return status;
    },
    relink: (next) => void page(next),
    onChange: (fn) => barListeners.add(fn),
    refreshStatus: async () => {
      if (!session) return;
      status = await api
        .getStatus(session)
        .then((r) => r.device)
        .catch(() => status);
      notifyBar();
    },
  };

  /*
   * Everything that edits the dial's settings goes inside one fieldset, which
   * is disabled until a dial is linked.
   *
   * A fieldset rather than a dimmed div: opacity alone is a lie, since you can
   * still tab into a greyed-out input and type into it. This actually disables
   * every control inside, in one attribute.
   */
  const settings = el(
    'fieldset',
    { class: 'fs stack' },
    pushCard,
    el('section', { class: 'card' }, el('h2', {}, 'Screens'), deckList),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'GitHub account'),
      el(
        'p',
        { class: 'muted' },
        'Whose stats this dial shows. Each device has its own settings, so ' +
          'changing this affects only this device. Switching applies straight ' +
          'away — it does not wait for Push.',
      ),
      loginInput,
      loginBtn,
      loginStatus,
    ),
    el('section', { class: 'card' }, el('h2', {}, 'Repos'), autoRow, repoCount, repoList),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Look'),
      el('label', { class: 'lbl' }, 'Accent'),
      accentRow,
      el('label', { class: 'lbl' }, 'Brightness'),
      el('div', { class: 'row' }, bright, brightLabel),
      el('label', { class: 'lbl' }, 'Auto-advance'),
      el('div', { class: 'row' }, rot, rotLabel),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Your GitHub'),
      el(
        'p',
        { class: 'muted' },
        'Private repos need your own GitHub access. It is read-only, and never ' +
          'reaches the device.',
      ),
      ghStatus,
      el('div', { class: 'row' }, ghConnect, ghDisconnect),
      ghInstallRow,
      patBox,
    ),
  ) as HTMLFieldSetElement;
  settings.disabled = !session;

  // Outside the fieldset on purpose: Wi-Fi is how an unlinked dial becomes a
  // linked one, and flashing needs Web Serial and nothing else -- it is what
  // you reach for when a device is too broken to link at all.
  const alwaysOn = el(
    'div',
    { class: 'stack' },
    wifiCard(pageCtx),
    firmwareCard(session),
  );

  const maintenance = el(
    'fieldset',
    { class: 'fs' },
    el(
      'section',
      { class: 'card' },
      el('div', { class: 'row' }, refreshBtn, refreshStatus),
      el(
        'p',
        { class: 'muted' },
        'Forgetting a dial only clears it from this browser. The device keeps its ' +
          'settings, and reconnecting over USB links it again.',
      ),
      forgetBtn,
    ),
  ) as HTMLFieldSetElement;
  maintenance.disabled = !session;

  show(
    el(
      'div',
      { class: 'split' },
      preview.node,
      el('div', { class: 'stack' }, deviceBar(pageCtx), settings, alwaysOn, maintenance, buildFooter()),
    ),
  );
  preview.draw();
}

/* --------------------------------- boot --------------------------------- */

/**
 * Take the device id + secret out of the URL Improv handed back. Returns null
 * for anything that is not one of our own settings URLs.
 */
function parseSession(next: string): api.Session | null {
  try {
    const url = new URL(next, location.href);
    if (url.origin !== location.origin) return null;
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    const id = params.get('d');
    const key = params.get('k');
    if (!id || !key) return null;
    return { id, key };
  } catch {
    return null;
  }
}

/** As above, and remember it. Reading the id is not the same as switching to it. */
function adoptSession(next: string): api.Session | null {
  const parsed = parseSession(next);
  return parsed ? api.saveSession(parsed) : null;
}

/**
 * Outcome of a GitHub sign-in, carried back by the callback's redirect as
 * `?github=`. Read once and removed from the address bar, so a reload -- or
 * relinking to another dial -- does not report it again.
 */
let githubOutcome: string | null = new URLSearchParams(location.search).get('github');
if (githubOutcome) history.replaceState(null, '', location.pathname + location.hash);

void page(api.readSession());
