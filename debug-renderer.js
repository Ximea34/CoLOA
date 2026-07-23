// debug-renderer.js — affichage brut du journal envoye par main.js.
// Ne reformule rien : chaque ligne vient telle quelle de aurora-client.js ou
// de la synthese que main.js fait de l'evaluation du moteur.

const log = document.getElementById("log");
const autoscroll = document.getElementById("autoscroll");
const MAX_ROWS = 2000;

let filter = "all";

function visible(dir, tag) {
  if (filter === "all") return true;
  if (filter === "err") return dir === "err";
  if (filter === "tcp") return tag === "tcp" || tag === "socket";
  if (filter === "engine") return tag === "engine";
  return true;
}

function scrollIfNeeded() {
  if (autoscroll.checked) log.scrollTop = log.scrollHeight;
}

function render(entry) {
  const row = document.createElement("div");
  row.className = "entry";
  row.dataset.dir = entry.dir;
  row.dataset.tag = entry.tag;
  row.hidden = !visible(entry.dir, entry.tag);

  const t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date(entry.t).toLocaleTimeString("fr-FR", { hour12: false });

  const tag = document.createElement("span");
  tag.className = "tag";
  tag.textContent = entry.tag;

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = entry.text;

  row.append(t, tag, text);
  return row;
}

function clearEmpty() {
  const p = log.querySelector(".debug-empty");
  if (p) p.remove();
}

document.querySelectorAll(".filter").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    filter = btn.dataset.filter;
    log.querySelectorAll(".entry").forEach((row) => {
      row.hidden = !visible(row.dataset.dir, row.dataset.tag);
    });
    scrollIfNeeded();
  });
});

document.getElementById("clear").addEventListener("click", () => {
  log.innerHTML = "";
  window.debugApi.clear();
});

window.debugApi.onBacklog((entries) => {
  log.innerHTML = "";
  if (!entries.length) {
    const p = document.createElement("p");
    p.className = "debug-empty";
    p.textContent = "En attente d'evenements...";
    log.append(p);
    return;
  }
  entries.forEach((entry) => log.append(render(entry)));
  scrollIfNeeded();
});

window.debugApi.onEntry((entry) => {
  clearEmpty();
  log.append(render(entry));
  while (log.querySelectorAll(".entry").length > MAX_ROWS) {
    log.querySelector(".entry").remove();
  }
  scrollIfNeeded();
});
