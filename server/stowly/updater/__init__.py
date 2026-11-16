"""Der Updater-Container (docs/integrationen.md, 10.7): ``python -m stowly.updater``.

Er läuft als root in einem zweiten Container aus demselben Image, mit dem Socket von Docker und
``--volumes-from`` des Stowly-Containers, und führt Updates über die Engine API aus. Der Server
selbst bekommt nie Zugriff auf Docker; er liefert nur den Befehl, der den Updater anlegt
(``stowly.updater.command``).

* ``docker``: die Engine API über den Unix-Socket, nur Standardbibliothek,
* ``clone``: die Regeln, nach denen aus dem alten Container der neue entsteht (reine Funktionen),
* ``run``: Herzschlag, Ziel, Update mit Journal und Wiederanlauf, Dateien ohne Symlinks.
"""
