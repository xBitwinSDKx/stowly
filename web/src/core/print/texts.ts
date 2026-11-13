/**
 * Sätze des Kerns zum Drucken. Die Oberfläche hat zu jedem Wert eigene Texte; diese hier sind
 * der Rückfall in `PrinterProbe.error` und `PrintFlushReport.problems[].message`.
 */
import type { PrinterProblem } from "@/contract/core";

export const PROBLEM_TEXTS: Record<PrinterProblem | "no_printer", string> = {
  offline: "Der Server ist nicht erreichbar.",
  unreachable: "Der Druckdienst antwortet auf keiner seiner Adressen. Ist das Gerät im WLAN des Druckers?",
  permission: "Der Browser hat dieser Seite den Zugriff auf das lokale Netzwerk verwehrt. Erlauben lässt er sich in den Einstellungen des Browsers für diese Seite.",
  blocked: "Der Druckdienst antwortet, lässt diese App aber nicht zu: Ihre Adresse fehlt in seiner Konfiguration.",
  not_verified: "Unter der Adresse antwortet kein Stowly-Druckdienst, der dieses Token kennt.",
  unknown_printer: "Der Druckdienst kennt diesen Drucker nicht.",
  insecure_context: "Direkt drucken geht nur, wenn Stowly über HTTPS geöffnet ist.",
  no_printer: "Diesen Etiketten ist kein Drucker zugeordnet.",
};

export const PRINT_TEXTS = {
  not_cancellable: "Das Etikett wird schon gedruckt und lässt sich nicht mehr verwerfen.",
  cancel_offline: "Der Druckdienst ist nicht erreichbar. Das Etikett wartet dort und lässt sich erst verwerfen, wenn er wieder antwortet.",
  cancel_lost: "Der Druckdienst kennt das Etikett nicht mehr. Ob es gedruckt wurde, ist offen.",
  no_job: "Das Etikett gibt es nicht.",
  no_image: "Zu diesem Etikett gibt es kein Bild.",
  image_offline: "Der Druckdienst ist nicht erreichbar.",
  preview_offline: "Die Vorschau braucht den Server, und er ist nicht erreichbar.",
  preview_failed: "Das Etikett lässt sich so nicht darstellen.",
  no_template: "Die Vorlage für dieses Etikett fehlt noch. Sie kommt mit dem nächsten Abgleich.",
  handoff_only_direct: "Die Seite des Druckdienstes gibt es nur bei einem direkten Drucker.",
  handoff_nothing: "Für diesen Drucker steht kein eigenes Etikett aus.",
} as const;
