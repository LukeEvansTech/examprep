// Question and choice HTML comes from ExamTopics: keep formatting tags only, and only
// let images point at our own /img store.
const TAGS = new Set([
  "P",
  "BR",
  "B",
  "STRONG",
  "I",
  "EM",
  "U",
  "CODE",
  "PRE",
  "UL",
  "OL",
  "LI",
  "SPAN",
  "DIV",
  "SUB",
  "SUP",
  "TABLE",
  "THEAD",
  "TBODY",
  "TR",
  "TD",
  "TH",
  "IMG",
  "A",
  "BLOCKQUOTE",
  "H4",
  "H5",
]);
const DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE", "NOSCRIPT"]);

function clean(el: Element, exam: string) {
  for (const child of [...el.children]) clean(child, exam); // children first, so unwrapped content is already clean
  if (el.tagName === "BODY") return;
  if (DROP.has(el.tagName)) return el.remove();
  if (!TAGS.has(el.tagName)) return el.replaceWith(...el.childNodes);

  const src = el.getAttribute("src");
  const href = el.getAttribute("href");
  for (const a of [...el.attributes]) el.removeAttribute(a.name);
  if (el.tagName === "IMG") {
    const name = src?.split("/").pop() ?? "";
    if (!/^[\w.-]+\.(png|jpe?g|gif|webp)$/i.test(name)) return el.remove();
    el.setAttribute("src", `/img/${exam}/${name}`);
    el.setAttribute("loading", "lazy");
    if (el.parentElement?.tagName !== "A") {
      const a = el.ownerDocument.createElement("a"); // tap to see the screenshot full size on a phone
      a.setAttribute("href", `/img/${exam}/${name}`);
      a.setAttribute("target", "_blank");
      el.replaceWith(a);
      a.append(el);
    }
  }
  if (el.tagName === "A" && href && /^https?:\/\//.test(href)) {
    el.setAttribute("href", href);
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener");
  }
}

export function sanitize(html: string, exam: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  clean(doc.body, exam);
  return doc.body.innerHTML;
}
