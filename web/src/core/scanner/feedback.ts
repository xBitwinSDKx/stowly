/**
 * Rückmeldung beim Scannen: Ton und Vibration (docs/recherche.md, Abschnitt 2).
 *
 * - Ton: ein `AudioContext`, der bei der ersten Berührung entsperrt wird; danach brauchen
 *   Töne keine Geste mehr. Am iPhone hält das System den Kontext an, sobald die App in den
 *   Hintergrund geht: Vor jedem Ton und bei der Rückkehr wird er wieder aufgenommen.
 * - Vibration: nur, wo es `navigator.vibrate` gibt. Safari kennt es nicht.
 *
 * Erfolg, Hinweis und Fehler klingen verschieden, damit man beim Einlagern nicht hinsehen muss.
 */

export type FeedbackTone =
  /** Eingelagert oder entnommen: zwei kurze, steigende Töne. */
  | "success"
  /** Zone gewechselt, Eingabe erwartet: ein kurzer Ton. */
  | "notice"
  /** Unbekannt, schon entnommen, nicht lesbar: ein tiefer, längerer Ton. */
  | "error";

export interface FeedbackPrefs {
  sound: boolean;
  vibration: boolean;
}

interface Note {
  /** Tonhöhe in Hertz. */
  frequency: number;
  /** Beginn in Sekunden ab jetzt. */
  start: number;
  /** Dauer in Sekunden. */
  duration: number;
}

const SOUNDS: Record<FeedbackTone, { wave: OscillatorType; volume: number; notes: Note[] }> = {
  success: {
    wave: "sine",
    volume: 0.22,
    notes: [
      { frequency: 880, start: 0, duration: 0.08 },
      { frequency: 1320, start: 0.09, duration: 0.11 },
    ],
  },
  notice: { wave: "sine", volume: 0.18, notes: [{ frequency: 660, start: 0, duration: 0.12 }] },
  error: {
    wave: "square",
    volume: 0.12,
    notes: [
      { frequency: 220, start: 0, duration: 0.16 },
      { frequency: 165, start: 0.18, duration: 0.24 },
    ],
  },
};

const VIBRATIONS: Record<FeedbackTone, number | number[]> = {
  success: 50,
  notice: 30,
  error: [80, 60, 80],
};

type AudioContextClass = new () => AudioContext;

let context: AudioContext | null = null;
let unlocked = false;
/** Die Scan-Ansicht ist offen: Nur dann läuft die Tonausgabe. */
let active = false;

function audioContextClass(): AudioContextClass | null {
  const scope = globalThis as { AudioContext?: AudioContextClass; webkitAudioContext?: AudioContextClass };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function ensureContext(): AudioContext | null {
  if (context) {
    return context;
  }
  const Class = audioContextClass();
  if (!Class) {
    return null;
  }
  try {
    context = new Class();
  } catch {
    context = null;
  }
  return context;
}

/** Nimmt einen angehaltenen Kontext wieder auf. Ohne vorherige Geste bleibt das wirkungslos. */
export function resumeAudio(): void {
  const current = context;
  if (current && current.state !== "running" && current.state !== "closed") {
    void current.resume().catch(() => undefined);
  }
}

/** Gibt die Tonausgabe frei, solange nicht gescannt wird. */
export function suspendAudio(): void {
  const current = context;
  if (current && current.state === "running") {
    void current.suspend().catch(() => undefined);
  }
}

/**
 * Entsperrt den Ton. Muss aus einer Geste des Anwenders heraus gerufen werden (Tippen,
 * Tastendruck): Vorher lässt kein Browser einen Ton zu. Solange nicht gescannt wird, ruht
 * die Tonausgabe danach wieder.
 */
export function unlockAudio(): void {
  const current = ensureContext();
  if (!current) {
    return;
  }
  if (unlocked) {
    if (active) {
      resumeAudio();
    }
    return;
  }
  unlocked = true;
  void current
    .resume()
    .then(() => {
      if (!active) {
        suspendAudio();
      }
    })
    .catch(() => undefined);
}

/**
 * Die Scan-Ansicht wird betreten oder verlassen: Die Tonausgabe läuft nur, solange gescannt
 * wird, und gibt die Lautsprecher sonst frei.
 */
export function setFeedbackActive(value: boolean): void {
  active = value;
  if (!unlocked) {
    return;
  }
  if (value) {
    resumeAudio();
  } else {
    suspendAudio();
  }
}

/** Wahr, sobald eine Geste den Ton entsperrt hat. */
export function isAudioUnlocked(): boolean {
  return unlocked && context !== null && context.state === "running";
}

/**
 * Entsperrt den Ton bei der ersten Berührung irgendwo auf der Seite und nimmt ihn wieder
 * auf, wenn die App aus dem Hintergrund zurückkommt. Liefert die Funktion zum Abmelden.
 */
export function installAudioUnlock(target: Document = document): () => void {
  const onGesture = () => unlockAudio();
  const onVisible = () => {
    if (target.visibilityState === "visible" && unlocked && active) {
      resumeAudio();
    }
  };
  const events = ["pointerdown", "touchend", "keydown"] as const;
  for (const event of events) {
    target.addEventListener(event, onGesture, { capture: true, passive: true });
  }
  target.addEventListener("visibilitychange", onVisible);
  return () => {
    for (const event of events) {
      target.removeEventListener(event, onGesture, { capture: true });
    }
    target.removeEventListener("visibilitychange", onVisible);
  };
}

function playSound(tone: FeedbackTone): void {
  const current = ensureContext();
  if (!current || !unlocked) {
    return;
  }
  resumeAudio();
  const sound = SOUNDS[tone];
  const now = current.currentTime;
  try {
    for (const note of sound.notes) {
      const oscillator = current.createOscillator();
      const gain = current.createGain();
      oscillator.type = sound.wave;
      oscillator.frequency.value = note.frequency;
      const start = now + note.start;
      const end = start + note.duration;
      // Weich ein- und ausblenden, sonst knackt es.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(sound.volume, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain);
      gain.connect(current.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
  } catch {
    // Kein Ton ist kein Grund, das Scannen zu stören.
  }
}

/** Wahr, wo der Browser vibrieren kann (Chrome für Android; Safari nicht). */
export function canVibrate(): boolean {
  return typeof (globalThis.navigator as Navigator | undefined)?.vibrate === "function";
}

function vibrate(tone: FeedbackTone): void {
  if (!canVibrate()) {
    return;
  }
  // Vor der ersten Berührung verweigert Chrome die Vibration und schreibt eine Warnung in die Konsole.
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (activation && !activation.hasBeenActive) {
    return;
  }
  try {
    navigator.vibrate(VIBRATIONS[tone]);
  } catch {
    // ohne Wirkung, z. B. vor der ersten Berührung
  }
}

/** Gibt die Rückmeldung für ein Ereignis, soweit der Anwender sie eingeschaltet hat. */
export function playFeedback(tone: FeedbackTone, prefs: FeedbackPrefs): void {
  if (prefs.sound) {
    playSound(tone);
  }
  if (prefs.vibration) {
    vibrate(tone);
  }
}
