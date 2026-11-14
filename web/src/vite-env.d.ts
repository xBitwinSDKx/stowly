/// <reference types="vite/client" />

/** Version der Web-App aus package.json, von Vite beim Bauen eingesetzt. */
declare const __APP_VERSION__: string;

/** Zeitpunkt des Bauens (ISO 8601), von Vite eingesetzt: Daran erkennt man, welcher Stand läuft. */
declare const __APP_BUILD__: string;
