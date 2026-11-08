/* Ferry embed: renders <a> buttons for elements like <div data-ferry-product="prd_..."></div>.
   It runs no payment logic on the host page; the button opens Ferry's hosted checkout. */
(function () {
  var script = document.currentScript; if (!script) return;
  var origin = new URL(script.src).origin;
  function mount(node) {
    if (node.getAttribute('data-ferry-mounted')) return;
    var id = node.getAttribute('data-ferry-product') || '';
    if (!/^prd_[A-Za-z0-9_-]{8,20}$/.test(id)) return;
    var a = document.createElement('a');
    a.href = origin + '/p/' + id; a.target = node.getAttribute('data-ferry-target') || '_blank'; a.rel = 'noopener';
    a.textContent = node.getAttribute('data-ferry-label') || 'Pay with crypto';
    a.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border-radius:12px;background:#1C222B;color:#F3EEE4;border:1px solid #3C4654;font:600 15px system-ui,sans-serif;text-decoration:none;min-height:44px';
    node.appendChild(a); node.setAttribute('data-ferry-mounted', '1');
  }
  function scan() { var n = document.querySelectorAll('[data-ferry-product]'); for (var i = 0; i < n.length; i++) mount(n[i]); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
})();
