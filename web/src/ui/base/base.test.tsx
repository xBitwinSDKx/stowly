import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState, type FormEvent } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it, vi } from "vitest";

import {
  Badge,
  Button,
  ButtonLink,
  Card,
  Dialog,
  dialogFocus,
  dialogFocusAlways,
  IconButton,
  SegmentedControl,
  Spinner,
  Switch,
  TextField,
  ToastProvider,
  useToast,
  ZONE_COLOR_KEYS,
  ZONE_ICON_KEYS,
  zoneColor,
  ZoneIcon,
} from ".";

describe("Button", () => {
  it("ist ein Button vom Typ button und meldet Klicks", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Speichern</Button>);
    const button = screen.getByRole("button", { name: "Speichern" });
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("sperrt sich, solange eine Aktion läuft, und sagt Screenreadern „beschäftigt, nicht verfügbar“", async () => {
    const onClick = vi.fn();
    const outside = vi.fn();
    render(
      <div onClick={outside}>
        <Button busy onClick={onClick}>
          Speichern
        </Button>
      </div>,
    );
    // Der Name bleibt: Der Spinner ist für Screenreader unsichtbar.
    const button = screen.getByRole("button", { name: "Speichern" });
    expect(button).toBeUnavailable();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-busy", "true");
    // Gesperrt nur über aria-disabled: Mit `disabled` verlöre sie im Browser den Fokus.
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    // Wie bei `disabled` erreicht der Klick auch die Umgebung nicht.
    expect(outside).not.toHaveBeenCalled();
  });

  it("behält den Fokus beim Wechsel zu „beschäftigt“ und zurück", async () => {
    const { rerender } = render(<Button>Speichern</Button>);
    const button = screen.getByRole("button", { name: "Speichern" });
    await userEvent.tab();
    expect(button).toHaveFocus();

    // jsdom nimmt einer gesperrten Schaltfläche den Fokus nicht, der Browser schon: Deshalb zählt auch, dass `disabled` fehlt.
    rerender(<Button busy>Speichern</Button>);
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    expect(button).toBeUnavailable();

    rerender(<Button>Speichern</Button>);
    expect(button).toHaveFocus();
    expect(button).toBeAvailable();
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("löst mit Klick, Enter und Leertaste nichts aus, solange sie arbeitet", async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Speichern</Button>);
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button busy onClick={onClick}>
        Speichern
      </Button>,
    );
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    await userEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("sendet als Formular-Knopf nichts ab, solange sie arbeitet, auch nicht mit Enter in einem Feld", async () => {
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    function Example({ busy }: { busy: boolean }) {
      return (
        <form onSubmit={onSubmit}>
          <TextField label="Name" />
          <Button type="submit" busy={busy}>
            Anlegen
          </Button>
        </form>
      );
    }
    const { rerender } = render(<Example busy={false} />);
    const field = screen.getByLabelText("Name");
    // Enter im Feld sendet das Formular ab: Der Browser klickt dafür den Formular-Knopf.
    await userEvent.type(field, "Keller{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);

    rerender(<Example busy />);
    await userEvent.type(field, "{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("lässt `disabled` ruhen, solange sie arbeitet", () => {
    const { rerender } = render(
      <Button busy disabled>
        Speichern
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Speichern" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");

    rerender(<Button disabled>Speichern</Button>);
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("behält den Fokus, wenn sie gesperrt wird, während sie ihn hat, und ist erst nach dem Verlassen ganz gesperrt", async () => {
    const onClick = vi.fn();
    function Example({ locked }: { locked: boolean }) {
      return (
        <>
          <Button disabled={locked} onClick={onClick}>
            Anlegen
          </Button>
          <Button>Weiter</Button>
        </>
      );
    }
    const { rerender } = render(<Example locked={false} />);
    const button = screen.getByRole("button", { name: "Anlegen" });
    await userEvent.tab();

    rerender(<Example locked />);
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Weiter" })).toHaveFocus();
    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button).toBeUnavailable();
  });

  it("reicht ein eigenes aria-disabled durch, solange keine Sperre gilt", () => {
    render(<Button aria-disabled="false">Speichern</Button>);
    expect(screen.getByRole("button", { name: "Speichern" })).toHaveAttribute("aria-disabled", "false");
  });

  it("kennt Varianten, Größen und die Formular-Typen", () => {
    render(
      <Button variant="danger" size="lg" block type="submit" className="eigene">
        Löschen
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Löschen" });
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveClass("danger", "lg", "block", "eigene");
  });

  it("trägt als IconButton seine Beschriftung für Screenreader", () => {
    render(
      <IconButton label="Taschenlampe">
        <svg />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Taschenlampe" })).toHaveAttribute("title", "Taschenlampe");
  });

  it("behält auch als IconButton den Fokus, wenn sie gesperrt wird, während sie ihn hat", async () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <IconButton label="Nach oben" onClick={onClick}>
        <svg />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Nach oben" });
    await userEvent.tab();
    rerender(
      <IconButton label="Nach oben" disabled onClick={onClick}>
        <svg />
      </IconButton>,
    );
    expect(button).toHaveFocus();
    expect(button).not.toBeDisabled();
    expect(button).toBeUnavailable();
    await userEvent.keyboard("{Enter}");
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("Card, Badge, Spinner", () => {
  it("zeichnen Zustände über Klassen", () => {
    render(
      <Card as="section" tone="accent" selected padding="lg" data-testid="card">
        <Badge tone="warn" solid>
          8
        </Badge>
        <Spinner label="Lädt" />
      </Card>,
    );
    const card = screen.getByTestId("card");
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveClass("card", "tone-accent", "selected", "padding-lg");
    expect(screen.getByText("8")).toHaveClass("badge", "warn", "solid");
    expect(screen.getByRole("status", { name: "Lädt" })).toBeInTheDocument();
  });
});

describe("Dialog", () => {
  function Example({ dismissable = true }: { dismissable?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Öffnen</Button>
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="Packung bearbeiten"
          dismissable={dismissable}
          footer={<Button onClick={() => setOpen(false)}>Fertig</Button>}
        >
          <p>Inhalt des Dialogs</p>
        </Dialog>
      </>
    );
  }

  it("rendert seinen Inhalt nur, solange er offen ist", async () => {
    render(<Example />);
    expect(screen.queryByText("Inhalt des Dialogs")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const dialog = screen.getByRole("dialog", { name: "Packung bearbeiten" });
    expect(within(dialog).getByText("Inhalt des Dialogs")).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByText("Inhalt des Dialogs")).not.toBeInTheDocument();
  });

  it("schließt über die Schaltflächen im Fuß", async () => {
    render(<Example />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    await userEvent.click(screen.getByRole("button", { name: "Fertig" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  function Focused({ mode }: { mode: "pointer" | "always" | "none" }) {
    const [open, setOpen] = useState(false);
    const [mounted, setMounted] = useState(true);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Öffnen</Button>
        <Button onClick={() => setMounted(false)}>Entfernen</Button>
        {mounted ? (
          <Dialog open={open} onClose={() => setOpen(false)} title="Name ändern">
            <TextField label="Zuerst" />
            <TextField ref={mode === "pointer" ? dialogFocus : mode === "always" ? dialogFocusAlways : undefined} label="Name" />
          </Dialog>
        ) : null}
      </>
    );
  }

  it("setzt den Anfangsfokus in das markierte Feld und gibt ihn beim Schließen zurück", async () => {
    render(<Focused mode="pointer" />);
    const opener = screen.getByRole("button", { name: "Öffnen" });
    await userEvent.click(opener);
    expect(screen.getByLabelText("Name")).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(opener).toHaveFocus();
  });

  it("lässt den Fokus ohne Markierung am Dialog selbst, nicht am Schließen-Knopf", async () => {
    render(<Focused mode="none" />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const dialog = screen.getByRole("dialog", { name: "Name ändern" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(within(dialog).getByRole("button", { name: "Schließen" })).not.toHaveFocus();
    expect(document.activeElement?.tagName).toBe("DIV");
  });

  it("öffnet bei Fingerbedienung nur auf Wunsch die Tastatur", async () => {
    // Fingerbedienung: Die Abfrage "(pointer: coarse)" trifft zu.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("coarse"), media: query })) as unknown as typeof window.matchMedia;
    try {
      const { unmount } = render(<Focused mode="pointer" />);
      await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
      expect(screen.getByLabelText("Name")).not.toHaveFocus();
      unmount();

      render(<Focused mode="always" />);
      await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
      expect(screen.getByLabelText("Name")).toHaveFocus();
    } finally {
      window.matchMedia = original;
    }
  });

  it("gibt den Fokus auch zurück, wenn der offene Dialog aus dem Baum fällt", async () => {
    render(<Focused mode="pointer" />);
    const opener = screen.getByRole("button", { name: "Öffnen" });
    await userEvent.click(opener);
    expect(screen.getByLabelText("Name")).toHaveFocus();
    // Ohne Klick entfernen: Der Fokus liegt noch im Dialog.
    act(() => screen.getByRole("button", { name: "Entfernen", hidden: true }).click());
    expect(opener).toHaveFocus();
  });

  it("gibt den Fokus auch im StrictMode zurück, in dem React jedes Aufräumen einmal probeweise ruft", async () => {
    // So öffnen die Ansichten ihre Dialoge: nur im Baum, solange sie offen sind.
    function Conditional() {
      const [shown, setShown] = useState(false);
      return (
        <>
          <Button onClick={() => setShown(true)}>Öffnen</Button>
          {shown ? (
            <Dialog open onClose={() => setShown(false)} title="Name ändern">
              <TextField ref={dialogFocus} label="Name" />
            </Dialog>
          ) : null}
        </>
      );
    }
    render(
      <StrictMode>
        <Conditional />
      </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "Öffnen" });
    await userEvent.click(opener);
    expect(screen.getByLabelText("Name")).toHaveFocus();

    await userEvent.click(screen.getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("nimmt den Fokus wieder auf, wenn im offenen Dialog das Element verschwindet, das ihn hatte", async () => {
    // Der Inhalt wechselt vom Formular zum Ergebnis: Die Schaltfläche, die eben gedrückt wurde, gibt es nicht mehr.
    function Steps() {
      const [done, setDone] = useState(false);
      return (
        <Dialog open onClose={() => undefined} title="Einlagern">
          {done ? <p>Eingelagert</p> : <Button onClick={() => setDone(true)}>Weiter</Button>}
        </Dialog>
      );
    }
    render(<Steps />);
    await userEvent.click(screen.getByRole("button", { name: "Weiter" }));
    expect(screen.getByText("Eingelagert")).toBeInTheDocument();
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("dialog", { name: "Einlagern" })).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByRole("button", { name: "Schließen" })).not.toHaveFocus();
  });

  it("bietet ohne dismissable kein Schließen von außen an", async () => {
    render(<Example dismissable={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(screen.queryByRole("button", { name: "Schließen" })).not.toBeInTheDocument();
    screen.getByRole("dialog").dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(screen.getByText("Inhalt des Dialogs")).toBeInTheDocument();
  });

  it("öffnet sich wieder, wenn der Browser ihn auf Escape selbst schließt, der Aufrufer ihn aber offen hält", async () => {
    // Chrome lässt ein Escape ohne vorherige Bedienung nicht abfangen: cancel ist dann nicht abbrechbar
    // und der Browser schließt selbst. Das ist hier nachgestellt.
    render(<Example dismissable={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    act(() => {
      dialog.dispatchEvent(new Event("cancel", { cancelable: false }));
      dialog.close();
    });
    expect(dialog).not.toHaveAttribute("open");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(dialog).toHaveAttribute("open");
    expect(within(dialog).getByText("Inhalt des Dialogs")).toBeInTheDocument();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  describe("solange er arbeitet (busy)", () => {
    function Working({ onClose }: { onClose: () => void }) {
      const [busy, setBusy] = useState(false);
      return (
        <Dialog
          open
          onClose={onClose}
          busy={busy}
          title="Zone löschen"
          footer={
            <Button variant="danger" busy={busy} onClick={() => setBusy(true)}>
              Löschen
            </Button>
          }
        >
          <p>Inhalt des Dialogs</p>
          <Button onClick={() => setBusy(false)}>Fertig gearbeitet</Button>
        </Dialog>
      );
    }

    it("lässt das ✕ an seinem Platz, sperrt es aber erkennbar und sagt, warum", async () => {
      const onClose = vi.fn();
      render(<Working onClose={onClose} />);
      const dialog = screen.getByRole("dialog", { name: "Zone löschen" });
      const close = within(dialog).getByRole("button", { name: "Schließen" });
      expect(close).toBeAvailable();
      expect(close).not.toHaveAttribute("title");

      await userEvent.click(within(dialog).getByRole("button", { name: "Löschen" }));
      expect(within(dialog).getByRole("button", { name: "Schließen" })).toBe(close);
      expect(close).toHaveAttribute("aria-disabled", "true");
      expect(close).toHaveAccessibleDescription("Schließen geht wieder, sobald der Vorgang abgeschlossen ist.");
      await userEvent.click(close);
      expect(onClose).not.toHaveBeenCalled();

      // Danach schließt es wieder.
      await userEvent.click(within(dialog).getByRole("button", { name: "Fertig gearbeitet" }));
      expect(close).toBeAvailable();
      await userEvent.click(close);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("schließt weder auf Escape noch auf ein Tippen daneben", async () => {
      const onClose = vi.fn();
      render(<Working onClose={onClose} />);
      const dialog = screen.getByRole("dialog", { name: "Zone löschen" });
      await userEvent.click(within(dialog).getByRole("button", { name: "Löschen" }));

      const cancel = new Event("cancel", { cancelable: true });
      act(() => {
        dialog.dispatchEvent(cancel);
      });
      expect(cancel.defaultPrevented).toBe(true);
      await userEvent.click(dialog);
      expect(onClose).not.toHaveBeenCalled();
      expect(within(dialog).getByText("Inhalt des Dialogs")).toBeInTheDocument();

      // Arbeitet er nicht mehr, schließen Escape und ein Tippen daneben wieder.
      await userEvent.click(within(dialog).getByRole("button", { name: "Fertig gearbeitet" }));
      act(() => {
        dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
      });
      await userEvent.click(dialog);
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it("behält den Fokus am ✕, wenn er zu arbeiten beginnt, während es ihn hat", async () => {
      const onClose = vi.fn();
      function FocusOnClose({ busy }: { busy: boolean }) {
        return (
          <Dialog open onClose={onClose} busy={busy} title="Speichern">
            <p>Inhalt</p>
          </Dialog>
        );
      }
      const { rerender } = render(<FocusOnClose busy={false} />);
      const close = screen.getByRole("button", { name: "Schließen" });
      close.focus();
      rerender(<FocusOnClose busy />);
      expect(close).toHaveFocus();
      expect(close).not.toBeDisabled();
      expect(close).toBeUnavailable();
      await userEvent.keyboard("{Enter}");
      await userEvent.keyboard(" ");
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  it("bleibt zu, wenn der Browser ihn schließt und der Aufrufer das annimmt", async () => {
    render(<Example />);
    const opener = screen.getByRole("button", { name: "Öffnen" });
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    act(() => {
      dialog.dispatchEvent(new Event("cancel", { cancelable: false }));
      dialog.close();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(dialog).not.toHaveAttribute("open");
    expect(screen.queryByText("Inhalt des Dialogs")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe("Toast", () => {
  function Example({ onUndo }: { onUndo: () => void }) {
    const toast = useToast();
    return (
      <Button
        onClick={() =>
          toast.show({ id: "entnommen", message: "Basmati Reis entnommen", action: { label: "Rückgängig", onAction: onUndo }, duration: 0 })
        }
      >
        Entnehmen
      </Button>
    );
  }

  it("zeigt eine Meldung mit Aktion und schließt sich danach", async () => {
    const onUndo = vi.fn();
    render(
      <ToastProvider>
        <Example onUndo={onUndo} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Entnehmen" }));
    expect(screen.getByRole("status")).toHaveTextContent("Basmati Reis entnommen");

    await userEvent.click(screen.getByRole("button", { name: "Rückgängig" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Basmati Reis entnommen")).not.toBeInTheDocument();
  });

  it("ersetzt eine Meldung mit derselben Kennung, statt sie zu stapeln", async () => {
    render(
      <ToastProvider>
        <Example onUndo={() => undefined} />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Entnehmen" }));
    await userEvent.click(screen.getByRole("button", { name: "Entnehmen" }));
    expect(screen.getAllByText("Basmati Reis entnommen")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: "Meldung schließen" }));
    expect(screen.queryByText("Basmati Reis entnommen")).not.toBeInTheDocument();
  });

  it("verlangt den ToastProvider", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Example onUndo={() => undefined} />)).toThrow(/ToastProvider/);
    quiet.mockRestore();
  });
});

describe("Eingaben", () => {
  it("Switch meldet den neuen Zustand", async () => {
    const onChange = vi.fn();
    render(<Switch label="Etiketten" hint="Beim Einlagern drucken" checked={false} onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Etiketten" });
    expect(control).toHaveAttribute("aria-checked", "false");
    expect(control).toHaveAccessibleDescription("Beim Einlagern drucken");
    await userEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("SegmentedControl meldet nur einen Wechsel", async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Thema"
        value="dark"
        onChange={onChange}
        options={[
          { value: "dark", label: "Dunkel" },
          { value: "light", label: "Hell" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Thema" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Dunkel" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "Dunkel" }));
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: "Hell" }));
    expect(onChange).toHaveBeenCalledWith("light");
  });

  it("SegmentedControl wählt mit den Pfeiltasten wie Optionsfelder", async () => {
    function Choice() {
      const [value, setValue] = useState("dark");
      return (
        <SegmentedControl
          label="Thema"
          value={value}
          onChange={setValue}
          options={[
            { value: "dark", label: "Dunkel" },
            { value: "light", label: "Hell" },
            { value: "off", label: "Aus", disabled: true },
            { value: "system", label: "Wie das Gerät" },
          ]}
        />
      );
    }
    render(<Choice />);
    await userEvent.click(screen.getByRole("radio", { name: "Dunkel" }));
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Hell" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Hell" })).toHaveFocus();
    // Gesperrte Möglichkeiten werden übersprungen; am Ende geht es vorn weiter.
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Wie das Gerät" })).toBeChecked();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Dunkel" })).toBeChecked();
    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Wie das Gerät" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "Dunkel" })).toBeChecked();
  });

  it("Switch und SegmentedControl behalten den Fokus, wenn sie gesperrt werden, während sie ihn haben", async () => {
    const onSwitch = vi.fn();
    const onChoice = vi.fn();
    function Example({ locked }: { locked: boolean }) {
      return (
        <>
          <Switch label="Etiketten" checked={false} onChange={onSwitch} disabled={locked} />
          <SegmentedControl
            label="Thema"
            value="dark"
            onChange={onChoice}
            options={[
              { value: "dark", label: "Dunkel" },
              { value: "light", label: "Hell", disabled: locked },
            ]}
          />
        </>
      );
    }
    const { rerender } = render(<Example locked={false} />);
    const control = screen.getByRole("switch", { name: "Etiketten" });
    await userEvent.tab();
    rerender(<Example locked />);
    expect(control).toHaveFocus();
    expect(control).not.toBeDisabled();
    expect(control).toBeUnavailable();
    await userEvent.click(control);
    expect(onSwitch).not.toHaveBeenCalled();

    // Ohne Fokus ganz gesperrt; die freie Wahl daneben bleibt bedienbar.
    rerender(<Example locked={false} />);
    await userEvent.tab();
    await userEvent.tab();
    const light = screen.getByRole("radio", { name: "Hell" });
    expect(light).toHaveFocus();
    rerender(<Example locked />);
    expect(control).toBeDisabled();
    expect(light).toHaveFocus();
    expect(light).not.toBeDisabled();
    expect(light).toBeUnavailable();
    await userEvent.click(light);
    expect(onChoice).not.toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Dunkel" })).toBeAvailable();
  });

  it("TextField verbindet Beschriftung, Hinweis und Fehler mit dem Feld", async () => {
    const { rerender } = render(<TextField label="Produktname" hint="Wie auf der Packung" defaultValue="" />);
    const input = screen.getByLabelText("Produktname");
    expect(input).toHaveAccessibleDescription("Wie auf der Packung");
    await userEvent.type(input, "Reis");
    expect(input).toHaveValue("Reis");

    rerender(<TextField label="Produktname" hint="Wie auf der Packung" error="Bitte einen Namen eingeben" defaultValue="" />);
    expect(screen.getByLabelText("Produktname")).toBeInvalid();
    expect(screen.getByRole("alert")).toHaveTextContent("Bitte einen Namen eingeben");
  });
});

describe("Zonen-Symbole und -Farben", () => {
  it("zeichnet jedes bekannte Symbol und für Unbekanntes die Kiste", () => {
    for (const key of ZONE_ICON_KEYS) {
      const { container, unmount } = render(<ZoneIcon icon={key} />);
      expect(container.querySelector("svg"), key).not.toBeNull();
      unmount();
    }
    const box = render(<ZoneIcon icon="box" />).container.innerHTML;
    const unknown = render(<ZoneIcon icon="gibt-es-nicht" />).container.innerHTML;
    expect(unknown).toBe(box);
  });

  it("löst Farbschlüssel in CSS-Variablen auf", () => {
    expect(ZONE_COLOR_KEYS).toContain("accent");
    expect(zoneColor("blue")).toBe("var(--palette-blue)");
    expect(zoneColor(null)).toBe("var(--color-accent)");
    expect(zoneColor("gibt-es-nicht")).toBe("var(--color-accent)");
    expect(zoneColor("toString")).toBe("var(--color-accent)");
  });
});

describe("ButtonLink", () => {
  it("sieht aus wie ein Button, ist aber ein Verweis und führt zur genannten Ansicht", async () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <ButtonLink to="/scan" variant="primary" size="lg" block icon={<svg data-testid="icon" />} className="eigene">
            Jetzt scannen
          </ButtonLink>
        ),
      },
      { path: "/scan", element: <h1>Scannen</h1> },
    ]);
    render(<RouterProvider router={router} />);
    const link = screen.getByRole("link", { name: "Jetzt scannen" });
    expect(link).toHaveAttribute("href", "/scan");
    // Dieselben Klassen wie die Schaltfläche: Variante, Größe, volle Breite; dazu die eigene.
    expect(link).toHaveClass("button", "primary", "lg", "block", "eigene");
    expect(within(link).getByTestId("icon")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();

    await userEvent.click(link);
    expect(router.state.location.pathname).toBe("/scan");
    expect(await screen.findByRole("heading", { name: "Scannen" })).toBeInTheDocument();
  });

  it("nimmt die Vorgaben der Schaltfläche (umrandet, mittlere Größe) und reicht die Props des Verweises durch", () => {
    const router = createMemoryRouter([
      {
        path: "/",
        element: (
          <ButtonLink to={{ pathname: "/drucker", hash: "#etiketten" }} replace aria-label="Zu den Etiketten" iconRight={<svg />}>
            Etiketten
          </ButtonLink>
        ),
      },
    ]);
    render(<RouterProvider router={router} />);
    const link = screen.getByRole("link", { name: "Zu den Etiketten" });
    expect(link).toHaveAttribute("href", "/drucker#etiketten");
    expect(link).toHaveClass("button", "secondary", "md");
    expect(link).not.toHaveClass("block");
  });
});

describe("Toast: alle schließen", () => {
  function Example() {
    const toast = useToast();
    return (
      <>
        <Button onClick={() => toast.show({ message: "Eins", duration: 0, action: { label: "Rückgängig", onAction: () => undefined } })}>Eins</Button>
        <Button onClick={() => toast.show({ message: "Zwei" })}>Zwei</Button>
        <Button onClick={() => toast.dismissAll()}>Sitzung endet</Button>
      </>
    );
  }

  it("räumt jede offene Meldung ab, auch die ohne Ablaufzeit", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ToastProvider>
        <Example />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Eins" }));
    await user.click(screen.getByRole("button", { name: "Zwei" }));
    expect(within(screen.getByRole("status")).getByText("Eins")).toBeInTheDocument();
    expect(within(screen.getByRole("status")).getByText("Zwei")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sitzung endet" }));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Rückgängig" })).not.toBeInTheDocument();

    // Die abgelaufene Uhr einer geschlossenen Meldung richtet nichts mehr an, und neue Meldungen erscheinen wieder.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    await user.click(screen.getByRole("button", { name: "Zwei" }));
    expect(within(screen.getByRole("status")).getByText("Zwei")).toBeInTheDocument();
    vi.useRealTimers();
  });
});
