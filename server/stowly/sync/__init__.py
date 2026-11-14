"""Der Sync: Befehle ausführen, Konflikte entscheiden, Änderungen ausliefern.

Pflichtenheft ist ``docs/sync-protokoll.md``. Die Teile:

* ``service``   Ablauf eines Aufrufs: Rahmen prüfen, eine Transaktion, Ergebnis je Befehl
* ``handlers``  die Befehle des Katalogs mit den Konfliktregeln
* ``changes``   Änderungsfolge: alles mit ``rev > cursor``, seitenweise
* ``idpool``    Vorrat an Packungs-IDs je Gerät
"""
