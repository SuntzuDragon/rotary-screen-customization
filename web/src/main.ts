import { applyAccent, resetAccent } from './accent';
import * as api from './api';
import { flashFirmware } from './flash';
import {
  closeShared,
  liveConnection,
  openShared,
  provision,
  serialSupported,
  type Connection,
  type Ssid,
} from './improv';
import { SIZE, buildCards, nextSection, render, type Card } from './render';
import { DEFAULT_ACCENT, type DeckId, type DeviceConfig, type DevicePayload } from './types';

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
 * Wi-Fi card. Changing networks is an edit, not a re-setup.
 *
 * Credentials only ever travel over USB -- pushing them through the service
 * would mean a wrong password leaves the device off the network and out of
 * reach of the very channel that could fix it. So this needs the cable, but it
 * needs nothing else: the device keeps its identity, so the session, settings
 * and history all survive a network change.
 *
 * The network it is *currently* on comes back the other way, from the device's
 * own polls, so the card can say where things stand with nothing plugged in.
 */
function wifiCard(session: api.Session) {
  const current = el('div', { class: 'status' });
  const changeBtn = el('button', { class: 'ghost' }, 'Change network');

  const select = el('select', { class: 'input' }) as HTMLSelectElement;
  const password = el('input', {
    class: 'input',
    type: 'password',
    placeholder: 'Wi-Fi password',
  }) as HTMLInputElement;
  const go = el('button', { class: 'primary' }, 'Connect to this network') as HTMLButtonElement;
  const cancel = el('button', { class: 'ghost' }, 'Cancel');
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
  const chosenSsid = () => (manual ? manual.value.trim() : select.value);

  const showCurrent = async () => {
    try {
      const st = await api.getStatus(session);
      const ssid = st.device?.wifiSsid;
      const rssi = st.device?.wifiRssi;
      current.replaceChildren(
        ssid
          ? note(`On ${ssid}${typeof rssi === 'number' ? ` · ${rssi} dBm` : ''}.`, 'ok')
          : note(
              'The device has not reported a network yet. It reports one each time it ' +
                'checks in.',
            ),
      );
    } catch {
      current.replaceChildren(note('Could not read the device status.', 'err'));
    }
  };
  void showCurrent();

  const loadNetworks = async (conn: Connection) => {
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
      // A device that cannot scan can still be told. Same fallback as setup.
      manual = el('input', { class: 'input', placeholder: 'Network name' }) as HTMLInputElement;
      select.replaceWith(manual);
    }
  };

  changeBtn.onclick = async () => {
    changeBtn.disabled = true;
    form.hidden = false;
    status.replaceChildren(note('Connecting over USB…'));
    try {
      const conn = await openShared((msg) => status.replaceChildren(note(msg)));
      status.replaceChildren(note('Asking the device what it can see…'));
      await loadNetworks(conn);
      status.replaceChildren(
        note('Pick the network the device should join. It keeps its settings either way.'),
      );
    } catch (err) {
      form.hidden = true;
      changeBtn.disabled = false;
      current.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
    }
  };

  cancel.onclick = () => {
    form.hidden = true;
    changeBtn.disabled = false;
  };

  go.onclick = async () => {
    const conn = liveConnection();
    if (!conn) {
      status.replaceChildren(note('The USB connection went away — try again.', 'err'));
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

      // The device hands back its own settings URL. A different id there means
      // the cable is in a different dial than the one this page is configuring
      // -- worth saying, because the change landed, just not where expected.
      const elsewhere = next ? adoptSession(next)?.id !== session.id : false;
      form.hidden = true;
      changeBtn.disabled = false;
      password.value = '';
      current.replaceChildren(
        note(
          elsewhere
            ? `Joined ${ssid}, but the cable is in a different device than this page.`
            : `Joined ${ssid}. Settings and history are unchanged.`,
          elsewhere ? 'info' : 'ok',
        ),
      );
      // The device reports its network on the next poll; nudge it so the line
      // above is confirmed by the device rather than assumed.
      await conn.improv.refresh().catch(() => null);
      void showCurrent();
    } catch (err) {
      status.replaceChildren(
        note(
          `${err instanceof Error ? err.message : String(err)} — the device went back to ` +
            'the network it was on.',
          'err',
        ),
      );
    }
    go.disabled = false;
  };

  return el(
    'section',
    { class: 'card' },
    el('h2', {}, 'Wi-Fi'),
    current,
    el(
      'p',
      { class: 'muted' },
      'Changing networks needs the USB cable — the password never goes through the ' +
        'internet. Nothing else is lost: the dial keeps its identity and settings.',
    ),
    changeBtn,
    form,
  );
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

      flashBtn.disabled = false;
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
      // open for instant pushes, hand it over first -- otherwise the port
      // picker offers a device that is already claimed and the flash fails
      // with nothing on screen to explain why.
      if (liveConnection()) {
        logLine('releasing the serial port held for instant push\n');
        await closeShared();
      }
      fwStatus.replaceChildren(note('Pick the device port, then keep it plugged in…'));

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
    flashBtn.disabled = false;
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

/* ------------------------------- landing ------------------------------- */

function landing() {
  subtitle.textContent = 'Plug the knob into this computer to set it up';
  // No device in hand yet, so nothing to match: back to the shipped colour.
  resetAccent();

  const btn = el('button', { class: 'primary' }, 'Connect device over USB');
  const status = el('div', { class: 'status' });

  btn.onclick = async () => {
    btn.disabled = true;
    status.replaceChildren(note('Waiting for you to pick a port…'));
    try {
      const conn = await openShared((msg) => status.replaceChildren(note(msg)));
      if (conn.nextUrl) {
        // Already provisioned: adopt the session and go, no Wi-Fi step needed.
        // The port stays open, so the first push from the settings page lands
        // on the dial immediately rather than at its next poll.
        const adopted = adoptSession(conn.nextUrl);
        if (adopted) {
          void configView(adopted);
          return;
        }
      }
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
  // Flashing is available here as well: a device that will not provision still
  // needs a way back, and flashing depends only on Web Serial.
  show(el('div', { class: 'stack' }, card, firmwareCard(null), buildFooter()));
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
  let manual: HTMLInputElement | null = null;
  const loadNetworks = async () => {
    try {
      const ssids = await conn.improv.scan();
      if (ssids.length === 0) throw new Error('no networks reported');
      select.replaceChildren(
        ...ssids.map((s) =>
          el('option', { value: s.name }, `${s.name}${s.secured ? '' : ' (open)'}  ·  ${s.rssi}dBm`),
        ),
      );
    } catch {
      // Fall back to typing it: a device that cannot scan can still be told.
      manual = el('input', { class: 'input', placeholder: 'Network name' }) as HTMLInputElement;
      select.replaceWith(manual);
    }
  };
  void loadNetworks();

  go.onclick = async () => {
    const ssid = manual ? manual.value : select.value;
    if (!ssid) {
      status.replaceChildren(note('Pick a network first.', 'err'));
      return;
    }
    go.disabled = true;
    status.replaceChildren(note('Connecting…'));
    try {
      const next = await provision(conn, ssid, password.value);
      if (next) {
        status.replaceChildren(note('Connected. Opening settings…', 'ok'));
        // The device's URL is same-origin and differs only in the hash, so
        // assigning location.href is a same-document navigation: nothing
        // reloads and the page sits on this message forever. Adopt the session
        // and render the settings view directly instead.
        const adopted = adoptSession(next);
        if (adopted) void configView(adopted);
        // Anything else came from the device and is not ours to navigate to. A
        // `javascript:` URL parses fine, has origin "null" so it fails the
        // check adoptSession makes, and would then run in this origin -- with
        // the session sitting in localStorage.
        else throw new Error(`the device pointed at ${next}, which is not this site`);
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

async function configView(session: api.Session) {
  subtitle.textContent = 'Settings';
  show(el('section', { class: 'card' }, note('Loading…')));

  let config: DeviceConfig;
  let payload: DevicePayload | null = null;
  try {
    config = await api.getConfig(session);
    // Wear the device's colour from the first paint, not from the first edit.
    applyAccent(config.theme.accent);
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
   * so a push always works. But when the cable is already in, the browser can
   * tell the device to fetch right now -- which turns "up to ten seconds, then
   * probably" into "done, and here is the confirmation from the device".
   */
  const usbNote = el('div', { class: 'status' });
  const usbBtn = el('button', { class: 'ghost' }, 'Connect over USB') as HTMLButtonElement;

  const paintUsb = (msg?: string, tone?: 'ok' | 'info' | 'err') => {
    const conn = liveConnection();
    usbBtn.textContent = conn ? 'Disconnect USB' : 'Connect over USB';
    usbBtn.disabled = false;
    usbNote.replaceChildren(
      note(
        msg ??
          (conn
            ? `Connected to ${conn.info.name} ${conn.info.version} — pushes apply instantly.`
            : 'Not connected. Pushes reach the dial at its next poll, within about ten ' +
              'seconds. Connect the cable to apply them instantly.'),
        tone ?? (conn ? 'ok' : 'info'),
      ),
    );
  };

  usbBtn.onclick = async () => {
    usbBtn.disabled = true;
    if (liveConnection()) {
      await closeShared();
      paintUsb();
      return;
    }
    usbNote.replaceChildren(note('Waiting for you to pick a port…'));
    try {
      await openShared((msg) => usbNote.replaceChildren(note(msg)));
      paintUsb();
    } catch (err) {
      paintUsb(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  if (!serialSupported()) {
    usbBtn.disabled = true;
    usbNote.replaceChildren(
      note('This browser has no Web Serial, so pushes arrive at the next poll.', 'info'),
    );
  } else {
    paintUsb();
  }

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
        paintUsb('Connected, but this firmware predates instant push — flash a newer build.', 'info');
        return false;
      }
      if (!ok) {
        paintUsb('The device could not reach the service just now.', 'err');
        return false;
      }
      paintUsb();
      return true;
    } catch (err) {
      // Usually the cable came out. Drop the stale connection rather than
      // leaving a button that claims a link which is gone.
      await closeShared();
      paintUsb(err instanceof Error ? err.message : String(err), 'err');
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
    preview.draw();
  };

  const edit = (patch: Partial<DeviceConfig>) => {
    draft = { ...draft, ...patch };
    refreshDirty();
  };

  pushBtn.onclick = async () => {
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

    // Otherwise confirm it at least reached the payload the device fetches:
    // "saved" alone would be a claim about this browser, not about the dial.
    pushNote.replaceChildren(note('Pushed — waiting for the service to pick it up…'));
    const deadline = Date.now() + 90000;
    for (;;) {
      const fresh = await api.getPreview(session).catch(() => null);
      if (fresh) payload = fresh;
      const agrees =
        fresh !== null &&
        fresh.decks.join() === config.decks.join() &&
        fresh.theme.accent === config.theme.accent &&
        (config.repos === null || fresh.repos.map((r) => r.n).join() === config.repos.join());
      if (agrees) {
        pushNote.replaceChildren(note('Live — the dial picks this up within about ten seconds.', 'ok'));
        break;
      }
      if (Date.now() > deadline) {
        pushNote.replaceChildren(note('Pushed, but the service has not caught up yet.'));
        break;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
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
  loginInput.oninput = () => {
    const v = loginInput.value.trim();
    // Changing account invalidates the repo selection: the names belong to the
    // previous user. null means "all repos", which is the right default here.
    if (/^[\w-]{1,39}$/.test(v)) edit({ login: v, repos: null });
  };

  /* repo picker */
  const repoList = el('div', { class: 'rows' }, note('Loading repos…'));
  api
    .getRepos(session)
    .then(({ repos }) => {
      repoList.replaceChildren(
        ...repos.map((r) => {
          const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
          cb.checked = draft.repos === null || draft.repos.includes(r.name);
          cb.onchange = async () => {
            const checked = [...repoList.querySelectorAll('input:checked')].map(
              (n) => (n as HTMLElement).dataset.name!,
            );
            edit({ repos: checked });
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


  /* optional personal GitHub token */
  const tokenInput = el('input', {
    class: 'input',
    type: 'password',
    placeholder: 'github_pat_...',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const tokenSave = el('button', { class: 'primary' }, 'Connect GitHub');
  const tokenRemove = el('button', { class: 'ghost' }, 'Disconnect');
  const tokenStatus = el('div', { class: 'status' });

  const paintToken = (present: boolean, detail?: string, tone?: 'ok' | 'info' | 'err') => {
    tokenRemove.style.display = present ? '' : 'none';
    tokenSave.textContent = present ? 'Replace token' : 'Connect GitHub';
    tokenStatus.replaceChildren(
      note(
        detail ??
          (present
            ? 'Using your token — private repos included, and requests count against your own rate limit.'
            : "Right now this uses the owner's token, so only public data is visible."),
        tone ?? (present ? 'ok' : 'info'),
      ),
    );
  };
  paintToken(false);
  api
    .tokenStatus(session)
    .then((s) =>
      paintToken(
        s.present,
        s.broken
          ? 'Your stored token can no longer be read — reconnect it. Until then this ' +
              "falls back to the owner's token and shows public data only."
          : undefined,
        s.broken ? 'err' : undefined,
      ),
    )
    .catch(() => {});

  tokenSave.onclick = async () => {
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
      paintToken(true, `Connected as ${login}.`);
      payload = await api.getPreview(session).catch(() => payload);
      preview.draw();
    } catch (err) {
      tokenStatus.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
    }
    tokenSave.disabled = false;
  };

  tokenRemove.onclick = async () => {
    tokenRemove.disabled = true;
    try {
      await api.clearToken(session);
      paintToken(false, 'Disconnected. Back to the built-in token.');
    } catch (err) {
      tokenStatus.replaceChildren(note(err instanceof Error ? err.message : String(err), 'err'));
    }
    tokenRemove.disabled = false;
  };


  // Once a session is stored the app goes straight here, with no route back to
  // the USB flow. Clearing Chrome's serial permission does not help -- that is
  // a browser grant, this is app state -- so there has to be an explicit way
  // out, both to reconnect and to hand the device to someone else.
  const forgetBtn = el('button', { class: 'ghost' }, 'Connect over USB again');
  forgetBtn.onclick = () => {
    api.clearSession();
    landing();
  };

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
        el('section', { class: 'card' }, pushBtn, pushNote, usbBtn, usbNote),
        el('section', { class: 'card' }, el('h2', {}, 'Screens'), deckList),
        el(
          'section',
          { class: 'card' },
          el('h2', {}, 'GitHub account'),
          el(
            'p',
            { class: 'muted' },
            'Whose stats this dial shows. Each device has its own settings, so ' +
              'changing this affects only this device.',
          ),
          loginInput,
        ),
        el('section', { class: 'card' }, el('h2', {}, 'Repos'), repoList),
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
            "Stats are fetched with the owner's GitHub token by default, which only " +
              'sees public data. Add your own to include private repos and use your ' +
              'own rate limit instead.',
          ),
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
            ' — read-only is enough. It is encrypted at rest, checked against GitHub ' +
              'before being saved, and never sent to the device.',
          ),
          tokenInput,
          el('div', { class: 'row' }, tokenSave, tokenRemove),
          tokenStatus,
        ),
        wifiCard(session),
        firmwareCard(session),
        el(
          'section',
          { class: 'card' },
          el('div', { class: 'row' }, refreshBtn, refreshStatus),
          el(
            'p',
            { class: 'muted' },
            'Reconnecting over USB re-reads the device identity — use it to point this ' +
              'page at a different device.',
          ),
          forgetBtn,
        ),
        buildFooter(),
      ),
    ),
  );
  preview.draw();
}

/* --------------------------------- boot --------------------------------- */

/**
 * Take the device id + secret out of the URL Improv handed back. Returns null
 * for anything that is not one of our own settings URLs.
 */
function adoptSession(next: string): api.Session | null {
  try {
    const url = new URL(next, location.href);
    if (url.origin !== location.origin) return null;
    const params = new URLSearchParams(url.hash.replace(/^#/, ''));
    const id = params.get('d');
    const key = params.get('k');
    if (!id || !key) return null;
    return api.saveSession({ id, key });
  } catch {
    return null;
  }
}

const session = api.readSession();
if (session) void configView(session);
else landing();
