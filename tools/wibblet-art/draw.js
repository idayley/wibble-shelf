// Shared by every wibblet drawing. Query options:
//   ?over=0.5     the reference picture on top at that opacity, the shapes in
//                 red under it: red rims are shape the picture doesn't have,
//                 grey without red is picture the shapes miss.
//   ?layer=body   only the body (or face), cropped to the body's bounds at
//                 207px tall, white on transparent. render.sh uses this.
(() => {
  const q = new URLSearchParams(location.search);
  const svg = document.getElementById("art");
  const ref = document.getElementById("ref");
  const body = document.getElementById("body");
  const face = document.getElementById("face");
  const H = 207;

  if (q.has("over")) {
    document.body.style.background = "#fff";
    body.setAttribute("fill", "#d33");
    face.setAttribute("fill", "#d33");
    svg.appendChild(ref);
    ref.setAttribute("opacity", q.get("over"));
    return;
  }
  ref?.remove();
  const layer = q.get("layer");
  if (layer === "body") face.remove();
  if (layer === "face") body.style.visibility = "hidden";

  // Crop to the body, the way Wibble expects: no padding, a fixed height.
  const b = body.getBBox();
  const aspect = Math.round((b.width / b.height) * 10000) / 10000;
  svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.width} ${b.height}`);
  svg.setAttribute("height", H);
  svg.setAttribute("width", Math.round(H * aspect));
  svg.setAttribute("preserveAspectRatio", "none");
  document.title = `aspect=${aspect} width=${Math.round(H * aspect)}`;
})();
