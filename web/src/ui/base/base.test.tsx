import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  Badge,
  Button,
  Card,
  Dialog,
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

  it("sperrt sich, solange eine Aktion läuft", async () => {
    const onClick = vi.fn();
    render(
      <Button busy onClick={onClick}>
        Speichern
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Speichern" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
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

  it("bietet ohne dismissable kein Schließen von außen an", async () => {
    render(<Example dismissable={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(screen.queryByRole("button", { name: "Schließen" })).not.toBeInTheDocument();
    screen.getByRole("dialog").dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(screen.getByText("Inhalt des Dialogs")).toBeInTheDocument();
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
