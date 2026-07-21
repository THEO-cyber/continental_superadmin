/* Continental — superadmin dashboard */
(function () {
  "use strict";

  var TOKEN_KEY = "continental_admin_token";
  var token = localStorage.getItem(TOKEN_KEY);
  var socket = null;
  var currentView = "dashboard";
  var refreshTimer = null;

  // Populated from the API (Admin > Categories) — superadmin can add more,
  // so this is never a fixed list. CATEGORIES[key] -> display name stays
  // available everywhere for backward-compatible lookups.
  var CATEGORIES = {};
  var categoriesCache = null;
  function ensureCategories(force) {
    if (categoriesCache && !force) return Promise.resolve(categoriesCache);
    return api("/api/admin/categories").then(function (res) {
      categoriesCache = res.categories;
      CATEGORIES = {};
      categoriesCache.forEach(function (c) {
        CATEGORIES[c.key] = c.name_en;
      });
      return categoriesCache;
    });
  }
  var LOW_STOCK = 5;

  // ---------- helpers ----------
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[c];
    });
  }
  function money(n) {
    return Number(n || 0).toLocaleString("fr-FR") + " FCFA";
  }
  function todayStr() {
    var d = new Date();
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }
  function timeOf(createdAt) {
    try {
      return new Date(
        String(createdAt).replace(" ", "T") + "Z",
      ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      return "";
    }
  }

  var toastEl = $("#toast"),
    toastTimer;
  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.className = "toast";
    }, 3200);
  }

  function downloadFile(url) {
    return fetch(url, { headers: { Authorization: "Bearer " + token } })
      .then(function (res) {
        if (!res.ok)
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (d) {
              throw new Error(d.error || "Download failed");
            });
        var disposition = res.headers.get("Content-Disposition") || "";
        var match = disposition.match(/filename="([^"]+)"/);
        var filename = match ? match[1] : "download";
        return res.blob().then(function (blob) {
          return { blob: blob, filename: filename };
        });
      })
      .then(function (result) {
        var objUrl = URL.createObjectURL(result.blob);
        var a = document.createElement("a");
        a.href = objUrl;
        a.download = result.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () {
          URL.revokeObjectURL(objUrl);
        }, 2000);
      });
  }

  // Opens a PDF in a new browser tab using its own viewer — no save dialog,
  // no file hitting disk. The endpoint needs an auth header a plain link
  // can't send, so this fetches the bytes first and hands the browser a
  // blob: URL instead (blob URLs are same-origin views of the raw bytes —
  // the resource's original Content-Disposition header no longer applies).
  function viewFile(url) {
    return fetch(url, { headers: { Authorization: "Bearer " + token } })
      .then(function (res) {
        if (!res.ok)
          return res
            .json()
            .catch(function () {
              return {};
            })
            .then(function (d) {
              throw new Error(d.error || "Could not open file");
            });
        return res.blob();
      })
      .then(function (blob) {
        var objUrl = URL.createObjectURL(blob);
        window.open(objUrl, "_blank");
        setTimeout(function () {
          URL.revokeObjectURL(objUrl);
        }, 60000);
      });
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = opts.form ? {} : { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.form
        ? opts.form
        : opts.body
          ? JSON.stringify(opts.body)
          : undefined,
    }).then(function (res) {
      if (res.status === 401) {
        logout();
        throw new Error("Session expired — sign in again");
      }
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok)
            throw new Error(
              data.error || "Request failed (" + res.status + ")",
            );
          return data;
        });
    });
  }

  // ---------- modal ----------
  var modalRoot = $("#modal-root");
  function openModal(html) {
    modalRoot.innerHTML =
      '<div class="modal-backdrop"><div class="modal">' + html + "</div></div>";
    var backdrop = modalRoot.firstChild;
    backdrop.addEventListener("mousedown", function (e) {
      if (e.target === backdrop) closeModal();
    });
    return backdrop.firstChild;
  }
  function closeModal() {
    modalRoot.innerHTML = "";
  }

  // ---------- auth ----------
  function showLogin() {
    $("#login-screen").hidden = false;
    $("#app").hidden = true;
  }
  function logout() {
    token = null;
    localStorage.removeItem(TOKEN_KEY);
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    showLogin();
  }

  $("#login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    var errEl = $("#login-error");
    errEl.hidden = true;
    api("/api/auth/login", {
      method: "POST",
      body: { username: f.username.value, password: f.password.value },
    })
      .then(function (data) {
        if (data.user.role !== "superadmin")
          throw new Error("This account is not a superadmin account");
        token = data.token;
        localStorage.setItem(TOKEN_KEY, token);
        f.reset();
        enterApp();
      })
      .catch(function (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      });
  });

  $("#logout-btn").addEventListener("click", logout);

  function enterApp() {
    $("#login-screen").hidden = true;
    $("#app").hidden = false;
    connectSocket();
    ensureCategories().then(function () {
      showView(currentView);
    });
  }

  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token: token } });
    socket.on("sale:recorded", function (sale) {
      toast(
        "💰 " +
          sale.worker_name +
          " sold " +
          sale.quantity +
          " × " +
          sale.product_name +
          " — " +
          money(sale.total),
      );
      scheduleRefresh();
    });
    socket.on("catalog:changed", function () {
      scheduleRefresh();
      refreshPendingBadge();
    });
    refreshPendingBadge();
  }

  function refreshPendingBadge() {
    api("/api/admin/products/pending")
      .then(function (res) {
        var badge = $("#pending-badge");
        var n = res.products.length;
        badge.textContent = n;
        badge.hidden = n === 0;
      })
      .catch(function () {});
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      if (!$("#app").hidden) views[currentView]();
    }, 350);
  }

  // ---------- navigation ----------
  $("#nav").addEventListener("click", function (e) {
    var btn = e.target.closest("button[data-view]");
    if (btn) showView(btn.getAttribute("data-view"));
  });

  function showView(name) {
    currentView = name;
    var btns = document.querySelectorAll("#nav button");
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle(
        "active",
        btns[i].getAttribute("data-view") === name,
      );
    }
    $("#view").innerHTML = '<p class="view-sub">Loading…</p>';
    views[name]();
  }

  // ================= DASHBOARD =================
  function renderDashboard() {
    Promise.all([
      api("/api/sales/daily"),
      api("/api/admin/products"),
      api("/api/admin/products?stock=out"),
      api("/api/admin/products/pending"),
    ])
      .then(function (res) {
        var daily = res[0],
          products = res[1].products,
          outOfStock = res[2].products,
          pending = res[3].products;
        var html =
          '<div class="view-head"><h1>Dashboard</h1><span class="cell-muted">' +
          esc(daily.date) +
          " · live</span></div>" +
          '<div class="stats">' +
          stat("Today's revenue", money(daily.total), "amber") +
          stat("Items sold today", daily.itemsSold) +
          stat("Products in catalog", products.length) +
          clickableStat(
            "outofstock",
            "Out of stock",
            outOfStock.length,
            outOfStock.length ? "red" : "",
          ) +
          clickableStat(
            "pending",
            "Pending approval",
            pending.length,
            pending.length ? "amber" : "",
          ) +
          "</div>" +
          '<div class="panel"><h2>Today\'s sales by product</h2><div class="table-wrap"><table>' +
          '<thead><tr><th></th><th>Product</th><th class="num">Quantity sold</th><th class="num">Amount</th></tr></thead><tbody>' +
          (daily.rows.length
            ? daily.rows
                .map(function (r) {
                  return (
                    '<tr><td><img class="thumb" src="' +
                    esc(r.image || "/assets/img/part-placeholder.svg") +
                    '" alt=""></td>' +
                    '<td class="cell-strong">' +
                    esc(r.product_name) +
                    "</td>" +
                    '<td class="num">' +
                    r.quantity +
                    "</td>" +
                    '<td class="num cell-strong">' +
                    money(r.amount) +
                    "</td></tr>"
                  );
                })
                .join("")
            : '<tr><td colspan="4" class="table-empty">No sales recorded yet today.</td></tr>') +
          "</tbody></table></div></div>" +
          '<div class="panel"><h2>Live sales feed (today)</h2><div class="feed">' +
          (daily.detail.length
            ? daily.detail
                .slice(0, 15)
                .map(function (s) {
                  return (
                    '<div class="feed-item"><div class="feed-main">' +
                    '<div class="feed-title">' +
                    s.quantity +
                    " × " +
                    esc(s.product_name) +
                    "</div>" +
                    '<div class="feed-sub">' +
                    esc(s.worker_name) +
                    " · " +
                    timeOf(s.created_at) +
                    "</div></div>" +
                    '<div class="feed-amount">' +
                    money(s.total) +
                    "</div></div>"
                  );
                })
                .join("")
            : '<p class="cell-muted">Sales appear here in real time as workers record them.</p>') +
          "</div></div>";
        $("#view").innerHTML = html;
        $("#view")
          .querySelectorAll("[data-goto]")
          .forEach(function (el) {
            el.addEventListener("click", function () {
              showView(el.getAttribute("data-goto"));
            });
          });
      })
      .catch(showError);
  }

  function stat(label, value, cls) {
    return (
      '<div class="stat"><div class="stat-label">' +
      esc(label) +
      "</div>" +
      '<div class="stat-value ' +
      (cls || "") +
      '">' +
      value +
      "</div></div>"
    );
  }

  function clickableStat(view, label, value, cls) {
    return (
      '<div class="stat stat-clickable" data-goto="' +
      view +
      '"><div class="stat-label">' +
      esc(label) +
      "</div>" +
      '<div class="stat-value ' +
      (cls || "") +
      '">' +
      value +
      "</div></div>"
    );
  }

  // ================= PRODUCTS =================
  var productFilters = { search: "", category: "", branchId: "" };

  function renderProducts() {
    Promise.all([
      api(
        "/api/admin/products?search=" +
          encodeURIComponent(productFilters.search) +
          "&category=" +
          encodeURIComponent(productFilters.category) +
          (productFilters.branchId
            ? "&branchId=" + productFilters.branchId
            : ""),
      ),
      ensureBranches(),
      ensureCategories(true),
    ])
      .then(function (res) {
        var products = res[0].products,
          branches = res[1],
          categories = res[2];
        var catName = productFilters.category
          ? CATEGORIES[productFilters.category] || productFilters.category
          : "";
        var html =
          '<div class="view-head"><h1>Products</h1>' +
          '<button class="btn btn-primary" data-action="add">＋ Add product</button>' +
          '<button class="btn btn-danger" id="delete-all-btn">🗑 Delete All</button>' +
          (productFilters.category
            ? '<button class="btn btn-danger" id="delete-cat-btn">🗑 Delete All in ' +
              esc(catName) +
              "</button>"
            : "") +
          "</div>" +
          '<div class="panel"><div class="toolbar" style="margin-bottom:.9rem">' +
          '<input id="p-search" type="search" placeholder="Search name, brand, SKU…" style="max-width:280px" value="' +
          esc(productFilters.search) +
          '">' +
          '<select id="p-category" style="max-width:220px"><option value="">All categories</option>' +
          categories
            .map(function (c) {
              return (
                '<option value="' +
                c.key +
                '"' +
                (productFilters.category === c.key ? " selected" : "") +
                ">" +
                esc(c.name_en) +
                "</option>"
              );
            })
            .join("") +
          "</select>" +
          (branches.length > 1
            ? '<select id="p-branch" style="max-width:200px"><option value="">All branches</option>' +
              branches
                .map(function (b) {
                  return (
                    '<option value="' +
                    b.id +
                    '"' +
                    (String(productFilters.branchId) === String(b.id)
                      ? " selected"
                      : "") +
                    ">" +
                    esc(b.name) +
                    "</option>"
                  );
                })
                .join("") +
              "</select>"
            : "") +
          "</div>" +
          '<div class="table-wrap"><table><thead><tr>' +
          "<th></th><th>Product</th><th>Category</th>" +
          (branches.length > 1 ? "<th>Branch</th>" : "") +
          '<th class="num">Price</th><th class="num">Stock</th><th>Visible on site</th><th>Actions</th>' +
          "</tr></thead><tbody>" +
          (products.length
            ? products
                .map(function (p) {
                  return (
                    '<tr data-id="' +
                    p.id +
                    '">' +
                    '<td><img class="thumb" src="' +
                    esc(p.image || "/assets/img/part-placeholder.svg") +
                    '" alt=""></td>' +
                    '<td><div class="cell-strong">' +
                    esc(p.name_en) +
                    '</div><div class="cell-muted">' +
                    esc(p.brand || "") +
                    (p.sku ? " · " + esc(p.sku) : "") +
                    "</div></td>" +
                    '<td><span class="badge badge-cat">' +
                    esc(CATEGORIES[p.category] || p.category) +
                    "</span></td>" +
                    (branches.length > 1
                      ? '<td class="cell-muted">' + esc(p.branch_name) + "</td>"
                      : "") +
                    '<td class="num cell-strong">' +
                    money(p.price) +
                    "</td>" +
                    '<td class="num' +
                    (p.quantity <= LOW_STOCK ? " low-stock" : "") +
                    '">' +
                    p.quantity +
                    "</td>" +
                    '<td><label class="toggle"><input type="checkbox" data-action="publish"' +
                    (p.published ? " checked" : "") +
                    '><span class="slider"></span></label></td>' +
                    '<td><div class="actions">' +
                    '<button class="btn btn-outline btn-xs" data-action="restock">Restock</button>' +
                    '<button class="btn btn-dark btn-xs" data-action="edit">Edit</button>' +
                    '<button class="btn btn-danger btn-xs" data-action="delete">Delete</button>' +
                    "</div></td></tr>"
                  );
                })
                .join("")
            : '<tr><td colspan="' +
              (branches.length > 1 ? 8 : 7) +
              '" class="table-empty">No products yet — click “Add product”.</td></tr>') +
          "</tbody></table></div></div>";
        $("#view").innerHTML = html;

        $("#p-search").addEventListener("input", function (e) {
          productFilters.search = e.target.value;
          clearTimeout(renderProducts._t);
          renderProducts._t = setTimeout(renderProducts, 300);
        });
        $("#p-category").addEventListener("change", function (e) {
          productFilters.category = e.target.value;
          renderProducts();
        });
        var branchSelect = $("#p-branch");
        if (branchSelect) {
          branchSelect.addEventListener("change", function (e) {
            productFilters.branchId = e.target.value;
            renderProducts();
          });
        }

        $("#delete-all-btn").addEventListener("click", function () {
          openDeleteConfirmModal({
            title: "Delete ALL products?",
            warning:
              "This removes every product in the catalog (" +
              products.length +
              " shown by the current filters, but this deletes the ENTIRE catalog regardless of filters — " +
              "every product, every category, every branch). Products with sales history are archived instead of deleted, so reports stay intact. This cannot be undone for the rest.",
            confirmWord: "DELETE ALL",
            onConfirm: function () {
              return api("/api/admin/products", { method: "DELETE" });
            },
          });
        });
        var deleteCatBtn = $("#delete-cat-btn");
        if (deleteCatBtn) {
          deleteCatBtn.addEventListener("click", function () {
            openDeleteConfirmModal({
              title: 'Delete all in "' + catName + '"?',
              warning:
                "This removes every product in this category. Products with sales history are archived instead of deleted, so reports stay intact. This cannot be undone for the rest.",
              confirmWord: "DELETE",
              onConfirm: function () {
                return api(
                  "/api/admin/products?category=" +
                    encodeURIComponent(productFilters.category),
                  { method: "DELETE" },
                );
              },
            });
          });
        }

        $("#view").onclick = function (e) {
          var btn = e.target.closest("[data-action]");
          if (!btn) return;
          var action = btn.getAttribute("data-action");
          if (action === "add") return openProductModal(null, branches);
          var row = btn.closest("tr[data-id]");
          if (!row) return;
          var id = Number(row.getAttribute("data-id"));
          var product = products.find(function (p) {
            return p.id === id;
          });
          if (action === "edit") openProductModal(product, branches);
          if (action === "restock") openRestockModal(product);
          if (action === "delete") deleteProduct(product);
          if (action === "publish") {
            api("/api/admin/products/" + id, {
              method: "PUT",
              body: { published: e.target.checked ? 1 : 0 },
            })
              .then(function () {
                toast(
                  e.target.checked
                    ? "Product is now visible on the client site"
                    : "Product hidden from the client site",
                );
              })
              .catch(function (err) {
                toast(err.message, true);
                renderProducts();
              });
          }
        };
      })
      .catch(showError);
  }

  function langFields(label, prefix, p) {
    p = p || {};
    return (
      '<fieldset class="lang-set"><legend>' +
      label +
      "</legend>" +
      "<label>Name" +
      (prefix === "en" ? " *" : "") +
      '<input name="name_' +
      prefix +
      '" value="' +
      esc(p["name_" + prefix] || "") +
      '"' +
      (prefix === "en" ? " required" : "") +
      "></label>" +
      '<label>Description<textarea name="desc_' +
      prefix +
      '">' +
      esc(p["desc_" + prefix] || "") +
      "</textarea></label>" +
      "</fieldset>"
    );
  }

  function openProductModal(product, branches) {
    var isEdit = !!product;
    branches = branches || [];
    var modal = openModal(
      "<h2>" +
        (isEdit ? "Edit product" : "Add product") +
        "</h2>" +
        '<form id="product-form" class="form-grid">' +
        langFields("English", "en", product) +
        langFields("Français", "fr", product) +
        langFields("中文", "zh", product) +
        '<div class="form-row">' +
        '<label>Category<select name="category">' +
        Object.keys(CATEGORIES)
          .map(function (k) {
            return (
              '<option value="' +
              k +
              '"' +
              (product && product.category === k ? " selected" : "") +
              ">" +
              CATEGORIES[k] +
              "</option>"
            );
          })
          .join("") +
        "</select></label>" +
        '<label>Brand<input name="brand" value="' +
        esc(product ? product.brand : "") +
        '"></label>' +
        '<label>SKU / Part No.<input name="sku" value="' +
        esc(product ? product.sku || "" : "") +
        '"></label>' +
        "</div>" +
        (branches.length > 1
          ? '<label>Branch<select name="branch_id">' +
            branches
              .map(function (b) {
                return (
                  '<option value="' +
                  b.id +
                  '"' +
                  (product && product.branch_id === b.id ? " selected" : "") +
                  ">" +
                  esc(b.name) +
                  "</option>"
                );
              })
              .join("") +
            "</select></label>"
          : "") +
        '<div class="form-row">' +
        '<label>Price (FCFA) *<input name="price" type="number" min="0" step="1" required value="' +
        (product ? product.price : "") +
        '"><span class="form-hint">Only visible to you and workers — never on the client site.</span></label>' +
        '<label>Quantity in stock *<input name="quantity" type="number" min="0" step="1" required value="' +
        (product ? product.quantity : 0) +
        '"></label>' +
        "</div>" +
        '<div class="form-row">' +
        '<label>Photo<input name="image" type="file" accept="image/jpeg,image/png,image/webp"><span class="form-hint">JPG, PNG or WebP — max 5 MB.</span></label>' +
        '<div class="form-col"><span>Preview</span><img class="img-preview" id="img-preview" src="' +
        esc((product && product.image) || "/assets/img/part-placeholder.svg") +
        '" alt=""></div>' +
        "</div>" +
        '<label style="display:flex;align-items:center;gap:.6rem">' +
        '<span class="toggle"><input type="checkbox" name="published"' +
        (!product || product.published ? " checked" : "") +
        '><span class="slider"></span></span>' +
        "Visible on the client site</label>" +
        '<p class="form-error" id="product-error" hidden></p>' +
        '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" id="cancel-product">Cancel</button>' +
        '<button type="submit" class="btn btn-primary">' +
        (isEdit ? "Save changes" : "Add product") +
        "</button>" +
        "</div></form>",
    );

    $("#cancel-product", modal).addEventListener("click", closeModal);
    var fileInput = modal.querySelector('input[name="image"]');
    fileInput.addEventListener("change", function () {
      if (fileInput.files[0])
        $("#img-preview", modal).src = URL.createObjectURL(fileInput.files[0]);
    });

    $("#product-form", modal).addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target;
      var form = new FormData();
      [
        "name_en",
        "name_fr",
        "name_zh",
        "desc_en",
        "desc_fr",
        "desc_zh",
        "category",
        "brand",
        "sku",
      ].forEach(function (k) {
        form.append(k, f[k].value);
      });
      form.append("price", f.price.value);
      form.append("quantity", f.quantity.value);
      form.append("published", f.published.checked ? "1" : "0");
      if (f.branch_id) form.append("branch_id", f.branch_id.value);
      if (fileInput.files[0]) form.append("image", fileInput.files[0]);

      var req = isEdit
        ? api("/api/admin/products/" + product.id, {
            method: "PUT",
            form: form,
          })
        : api("/api/admin/products", { method: "POST", form: form });
      req
        .then(function () {
          closeModal();
          toast(
            isEdit
              ? "Product updated — client site refreshed instantly"
              : "Product added — now live on the client site",
          );
          renderProducts();
        })
        .catch(function (err) {
          var el = $("#product-error", modal);
          el.textContent = err.message;
          el.hidden = false;
        });
    });
  }

  // Shared "type the word to confirm" modal for irreversible bulk actions.
  function openDeleteConfirmModal(opts) {
    var modal = openModal(
      '<h2 style="color:var(--red)">' +
        esc(opts.title) +
        "</h2>" +
        '<p class="cell-muted" style="margin-bottom:1rem">' +
        esc(opts.warning) +
        "</p>" +
        '<form id="confirm-form" class="form-grid">' +
        "<label>Type <strong>" +
        esc(opts.confirmWord) +
        '</strong> to confirm<input name="confirm" autocomplete="off" autofocus></label>' +
        '<p class="form-error" id="confirm-error" hidden></p>' +
        '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" id="cancel-confirm">Cancel</button>' +
        '<button type="submit" class="btn btn-danger" id="confirm-submit" disabled>' +
        esc(opts.confirmWord) +
        "</button>" +
        "</div></form>",
    );
    var input = modal.querySelector('input[name="confirm"]');
    var submitBtn = $("#confirm-submit", modal);
    input.addEventListener("input", function () {
      submitBtn.disabled =
        input.value.trim().toUpperCase() !== opts.confirmWord.toUpperCase();
    });
    $("#cancel-confirm", modal).addEventListener("click", closeModal);
    $("#confirm-form", modal).addEventListener("submit", function (e) {
      e.preventDefault();
      if (input.value.trim().toUpperCase() !== opts.confirmWord.toUpperCase())
        return;
      submitBtn.disabled = true;
      opts
        .onConfirm()
        .then(function (res) {
          closeModal();
          var msg =
            "Deleted " +
            (res.deleted || 0) +
            " product(s)" +
            (res.archived
              ? ", archived " + res.archived + " (had sales history)"
              : "") +
            ".";
          toast(msg);
          renderProducts();
        })
        .catch(function (err) {
          var el = $("#confirm-error", modal);
          el.textContent = err.message;
          el.hidden = false;
          submitBtn.disabled = false;
        });
    });
  }

  function openRestockModal(product, onDone) {
    var modal = openModal(
      "<h2>Restock — " +
        esc(product.name_en) +
        "</h2>" +
        '<form id="restock-form" class="form-grid">' +
        '<p class="cell-muted">Current stock: <strong>' +
        product.quantity +
        "</strong></p>" +
        '<label>Quantity to add<input name="delta" type="number" min="1" step="1" value="1" required autofocus></label>' +
        '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" id="cancel-restock">Cancel</button>' +
        '<button type="submit" class="btn btn-primary">Add stock</button></div></form>',
    );
    $("#cancel-restock", modal).addEventListener("click", closeModal);
    $("#restock-form", modal).addEventListener("submit", function (e) {
      e.preventDefault();
      api("/api/admin/products/" + product.id + "/stock", {
        method: "PATCH",
        body: { delta: Number(e.target.delta.value) },
      })
        .then(function (res) {
          closeModal();
          toast("Stock updated: " + res.product.quantity + " in stock");
          (onDone || renderProducts)();
        })
        .catch(function (err) {
          toast(err.message, true);
        });
    });
  }

  function deleteProduct(product) {
    if (
      !confirm(
        'Remove "' +
          product.name_en +
          '" from the catalog?\nIt disappears from the client site instantly.',
      )
    )
      return;
    api("/api/admin/products/" + product.id, { method: "DELETE" })
      .then(function (res) {
        toast(
          res.archived
            ? "Product had sales history — it was hidden and zeroed instead of deleted"
            : "Product deleted",
        );
        renderProducts();
      })
      .catch(function (err) {
        toast(err.message, true);
      });
  }

  // ================= SALES =================
  var salesDate = null;

  function renderSales() {
    var date = salesDate || todayStr();
    Promise.all([
      api("/api/sales/daily?date=" + date),
      api("/api/sales/summary?days=30"),
    ])
      .then(function (res) {
        var daily = res[0],
          summary = res[1].days;
        var html =
          '<div class="view-head"><h1>Sales</h1>' +
          '<input type="date" id="sales-date" value="' +
          esc(date) +
          '" style="max-width:180px"></div>' +
          '<div class="stats">' +
          stat("Total for " + daily.date, money(daily.total), "amber") +
          stat("Items sold", daily.itemsSold) +
          stat("Transactions", daily.detail.length) +
          "</div>" +
          '<div class="panel"><h2>Sales by product ' +
          esc(daily.date) +
          '</h2><div class="table-wrap"><table>' +
          '<thead><tr><th></th><th>Product</th><th class="num">Quantity</th><th class="num">Amount</th></tr></thead><tbody>' +
          (daily.rows.length
            ? daily.rows
                .map(function (r) {
                  return (
                    '<tr><td><img class="thumb" src="' +
                    esc(r.image || "/assets/img/part-placeholder.svg") +
                    '" alt=""></td>' +
                    '<td class="cell-strong">' +
                    esc(r.product_name) +
                    "</td>" +
                    '<td class="num">' +
                    r.quantity +
                    "</td>" +
                    '<td class="num cell-strong">' +
                    money(r.amount) +
                    "</td></tr>"
                  );
                })
                .join("")
            : '<tr><td colspan="4" class="table-empty">No sales on this day.</td></tr>') +
          (daily.rows.length
            ? '<tr><td></td><td class="cell-strong">TOTAL</td><td class="num cell-strong">' +
              daily.itemsSold +
              '</td><td class="num cell-strong" style="color:var(--amber-dark)">' +
              money(daily.total) +
              "</td></tr>"
            : "") +
          "</tbody></table></div></div>" +
          '<div class="panel"><h2>Every transaction ' +
          esc(daily.date) +
          '</h2><div class="table-wrap"><table>' +
          '<thead><tr><th>Time</th><th>Product</th><th>Worker</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th><th></th></tr></thead><tbody>' +
          (daily.detail.length
            ? daily.detail
                .map(function (s) {
                  return (
                    '<tr data-sale="' +
                    s.id +
                    '"><td>' +
                    timeOf(s.created_at) +
                    "</td>" +
                    '<td class="cell-strong">' +
                    esc(s.product_name) +
                    "</td>" +
                    "<td>" +
                    esc(s.worker_name) +
                    "</td>" +
                    '<td class="num">' +
                    s.quantity +
                    "</td>" +
                    '<td class="num">' +
                    money(s.unit_price) +
                    "</td>" +
                    '<td class="num cell-strong">' +
                    money(s.total) +
                    "</td>" +
                    '<td><button class="btn btn-danger btn-xs" data-del-sale="' +
                    s.id +
                    '" title="Delete this sale and restore stock">✕</button></td></tr>'
                  );
                })
                .join("")
            : '<tr><td colspan="7" class="table-empty">No transactions.</td></tr>') +
          "</tbody></table></div></div>" +
          '<div class="panel"><h2>Last 30 days</h2><div class="table-wrap"><table>' +
          '<thead><tr><th>Date</th><th class="num">Items sold</th><th class="num">Transactions</th><th class="num">Total</th></tr></thead><tbody>' +
          (summary.length
            ? summary
                .map(function (d) {
                  return (
                    '<tr data-day="' +
                    esc(d.sale_date) +
                    '" style="cursor:pointer" title="View this day">' +
                    '<td class="cell-strong">' +
                    esc(d.sale_date) +
                    "</td>" +
                    '<td class="num">' +
                    d.quantity +
                    "</td>" +
                    '<td class="num">' +
                    d.transactions +
                    "</td>" +
                    '<td class="num cell-strong">' +
                    money(d.amount) +
                    "</td></tr>"
                  );
                })
                .join("")
            : '<tr><td colspan="4" class="table-empty">No sales recorded yet.</td></tr>') +
          "</tbody></table></div></div>" +
          '<div class="panel"><h2>Business records</h2>' +
          '<p class="cell-muted" style="margin-bottom:.8rem">Download the full sales ledger every transaction ever recorded, or a chosen date range as a spreadsheet-ready CSV file.</p>' +
          '<div class="toolbar">' +
          '<label class="cell-muted" style="font-size:.82rem">From <input id="export-from" type="date" style="width:auto"></label>' +
          '<label class="cell-muted" style="font-size:.82rem">To <input id="export-to" type="date" style="width:auto"></label>' +
          '<button class="btn btn-dark btn-xs" id="export-ledger">⬇ Export CSV</button>' +
          "</div></div>";
        $("#view").innerHTML = html;

        $("#sales-date").addEventListener("change", function (e) {
          salesDate = e.target.value;
          renderSales();
        });
        $("#export-ledger").addEventListener("click", function () {
          var from = $("#export-from").value,
            to = $("#export-to").value;
          var params = [];
          if (from) params.push("from=" + from);
          if (to) params.push("to=" + to);
          downloadFile(
            "/api/sales/export" + (params.length ? "?" + params.join("&") : ""),
          ).catch(function (err) {
            toast(err.message, true);
          });
        });
        $("#view").onclick = function (e) {
          var del = e.target.closest("[data-del-sale]");
          if (del) {
            if (
              !confirm(
                "Delete this sale? The sold quantity is returned to stock.",
              )
            )
              return;
            api("/api/sales/" + del.getAttribute("data-del-sale"), {
              method: "DELETE",
            })
              .then(function () {
                toast("Sale deleted — stock restored");
                renderSales();
              })
              .catch(function (err) {
                toast(err.message, true);
              });
            return;
          }
          var day = e.target.closest("tr[data-day]");
          if (day) {
            salesDate = day.getAttribute("data-day");
            renderSales();
          }
        };
      })
      .catch(showError);
  }

  // ================= WORKERS =================
  function renderWorkers() {
    api("/api/admin/workers")
      .then(function (res) {
        var workers = res.workers;
        var html =
          '<div class="view-head"><h1>Workers</h1>' +
          '<button class="btn btn-primary" id="add-worker">＋ Add worker</button></div>' +
          '<p class="view-sub">Workers sign in at <strong>/workers</strong> on any phone or computer to record sales.</p>' +
          '<div class="panel"><div class="table-wrap"><table>' +
          '<thead><tr><th>Name</th><th>Username</th><th>Status</th><th class="num">Sold today</th><th class="num">Amount today</th><th>Actions</th></tr></thead><tbody>' +
          (workers.length
            ? workers
                .map(function (w) {
                  return (
                    '<tr data-id="' +
                    w.id +
                    '">' +
                    '<td class="cell-strong">' +
                    esc(w.name) +
                    "</td>" +
                    '<td class="cell-muted">' +
                    esc(w.username) +
                    "</td>" +
                    '<td><span class="badge ' +
                    (w.active ? 'badge-on">Active' : 'badge-off">Disabled') +
                    "</span></td>" +
                    '<td class="num">' +
                    w.today_items +
                    "</td>" +
                    '<td class="num cell-strong">' +
                    money(w.today_amount) +
                    "</td>" +
                    '<td><div class="actions">' +
                    '<button class="btn btn-outline btn-xs" data-action="toggle">' +
                    (w.active ? "Disable" : "Enable") +
                    "</button>" +
                    '<button class="btn btn-dark btn-xs" data-action="password">Reset password</button>' +
                    '<button class="btn btn-danger btn-xs" data-action="remove">Delete</button>' +
                    "</div></td></tr>"
                  );
                })
                .join("")
            : '<tr><td colspan="6" class="table-empty">No workers yet — add your first worker account.</td></tr>') +
          "</tbody></table></div></div>";
        $("#view").innerHTML = html;

        $("#add-worker").addEventListener("click", openWorkerModal);
        $("#view").onclick = function (e) {
          var btn = e.target.closest("[data-action]");
          if (!btn) return;
          var row = btn.closest("tr[data-id]");
          var id = Number(row.getAttribute("data-id"));
          var worker = workers.find(function (w) {
            return w.id === id;
          });
          var action = btn.getAttribute("data-action");
          if (action === "toggle") {
            api("/api/admin/workers/" + id, {
              method: "PATCH",
              body: { active: worker.active ? 0 : 1 },
            })
              .then(function () {
                toast(worker.active ? "Worker disabled" : "Worker enabled");
                renderWorkers();
              })
              .catch(function (err) {
                toast(err.message, true);
              });
          }
          if (action === "password") openPasswordReset(worker);
          if (action === "remove") {
            if (!confirm('Delete worker "' + worker.name + '"?')) return;
            api("/api/admin/workers/" + id, { method: "DELETE" })
              .then(function (res2) {
                toast(
                  res2.archived
                    ? "Worker had sales history — account was deactivated instead"
                    : "Worker deleted",
                );
                renderWorkers();
              })
              .catch(function (err) {
                toast(err.message, true);
              });
          }
        };
      })
      .catch(showError);
  }

  function openWorkerModal() {
    var modal = openModal(
      "<h2>Add worker</h2>" +
        '<form id="worker-form" class="form-grid">' +
        '<label>Full name<input name="name" required></label>' +
        '<label>Username<input name="username" required pattern="[a-zA-Z0-9_.\\-]{3,30}"><span class="form-hint">3–30 characters, letters/numbers/._- only</span></label>' +
        '<label>Password<input name="password" type="text" required minlength="8"><span class="form-hint">At least 8 characters — share it with the worker.</span></label>' +
        '<p class="form-error" id="worker-error" hidden></p>' +
        '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" id="cancel-worker">Cancel</button>' +
        '<button type="submit" class="btn btn-primary">Create account</button></div></form>',
    );
    $("#cancel-worker", modal).addEventListener("click", closeModal);
    $("#worker-form", modal).addEventListener("submit", function (e) {
      e.preventDefault();
      var f = e.target;
      api("/api/admin/workers", {
        method: "POST",
        body: {
          name: f.name.value,
          username: f.username.value,
          password: f.password.value,
        },
      })
        .then(function () {
          closeModal();
          toast("Worker account created");
          renderWorkers();
        })
        .catch(function (err) {
          var el = $("#worker-error", modal);
          el.textContent = err.message;
          el.hidden = false;
        });
    });
  }

  function openPasswordReset(worker) {
    var modal = openModal(
      "<h2>Reset password — " +
        esc(worker.name) +
        "</h2>" +
        '<form id="pw-form" class="form-grid">' +
        '<label>New password<input name="password" type="text" required minlength="8"></label>' +
        '<div class="modal-actions">' +
        '<button type="button" class="btn btn-outline" id="cancel-pw">Cancel</button>' +
        '<button type="submit" class="btn btn-primary">Reset</button></div></form>',
    );
    $("#cancel-pw", modal).addEventListener("click", closeModal);
    $("#pw-form", modal).addEventListener("submit", function (e) {
      e.preventDefault();
      api("/api/admin/workers/" + worker.id, {
        method: "PATCH",
        body: { password: e.target.password.value },
      })
        .then(function () {
          closeModal();
          toast("Password reset");
        })
        .catch(function (err) {
          toast(err.message, true);
        });
    });
  }

  // ================= REPORTS (per-worker day/month/year) =================
  var reportsState = { workerId: null, period: "day", date: null };

  function shiftDate(dateStr, period, dir) {
    if (period === "year") return String(Number(dateStr) + dir);
    if (period === "month") {
      var parts = dateStr.split("-").map(Number);
      var d = new Date(parts[0], parts[1] - 1 + dir, 1);
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    }
    var d2 = new Date(dateStr + "T00:00:00");
    d2.setDate(d2.getDate() + dir);
    return (
      d2.getFullYear() +
      "-" +
      String(d2.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d2.getDate()).padStart(2, "0")
    );
  }

  function defaultDateFor(period) {
    var now = new Date();
    if (period === "year") return String(now.getFullYear());
    if (period === "month")
      return (
        now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0")
      );
    return todayStr();
  }

  function renderReports() {
    api("/api/admin/workers")
      .then(function (res) {
        var workers = res.workers;
        if (!workers.length) {
          $("#view").innerHTML =
            '<div class="view-head"><h1>Reports</h1></div>' +
            '<div class="panel"><p class="cell-muted">Add a worker first — reports appear per worker once they have sales.</p></div>';
          return;
        }
        if (
          !reportsState.workerId ||
          !workers.some(function (w) {
            return w.id === reportsState.workerId;
          })
        ) {
          reportsState.workerId = workers[0].id;
        }
        if (!reportsState.date)
          reportsState.date = defaultDateFor(reportsState.period);
        loadWorkerReport(workers);
      })
      .catch(showError);
  }

  function loadWorkerReport(workers) {
    var s = reportsState;
    api(
      "/api/sales/worker/" +
        s.workerId +
        "?period=" +
        s.period +
        "&date=" +
        encodeURIComponent(s.date),
    )
      .then(function (report) {
        renderReportsView(workers, report);
      })
      .catch(showError);
  }

  function periodLabel(report) {
    if (report.period === "day") return report.label;
    if (report.period === "month") {
      var d = new Date(report.label + "-01T00:00:00");
      return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
    }
    return report.label;
  }

  function breakdownKeyLabel(period, key) {
    if (period === "year") {
      var d = new Date(key + "-01T00:00:00");
      return d.toLocaleDateString("en-US", { month: "short" });
    }
    return key;
  }

  function renderReportsView(workers, report) {
    var s = reportsState;
    var html =
      '<div class="view-head"><h1>Reports</h1></div>' +
      '<p class="view-sub">Every worker\'s sales, kept separate and searchable by day, month or year — never mixed into one pile.</p>' +
      '<div class="panel">' +
      '<div class="toolbar" style="margin-bottom:1rem;flex-wrap:wrap">' +
      '<select id="rep-worker" style="max-width:220px">' +
      workers
        .map(function (w) {
          return (
            '<option value="' +
            w.id +
            '"' +
            (w.id === s.workerId ? " selected" : "") +
            ">" +
            esc(w.name) +
            "</option>"
          );
        })
        .join("") +
      "</select>" +
      '<div class="period-tabs">' +
      ["day", "month", "year"]
        .map(function (p) {
          return (
            '<button class="period-tab' +
            (s.period === p ? " active" : "") +
            '" data-period="' +
            p +
            '">' +
            p.charAt(0).toUpperCase() +
            p.slice(1) +
            "</button>"
          );
        })
        .join("") +
      "</div>" +
      '<div class="date-nav">' +
      '<button class="btn btn-outline btn-xs" id="rep-prev">‹ Prev</button>' +
      '<strong id="rep-label">' +
      esc(periodLabel(report)) +
      "</strong>" +
      '<button class="btn btn-outline btn-xs" id="rep-next">Next ›</button>' +
      "</div>" +
      '<button class="btn btn-dark btn-xs" id="rep-export" style="margin-left:auto">⬇ Export CSV</button>' +
      "</div>" +
      '<div class="stats" style="margin-bottom:0">' +
      stat("Revenue — " + report.worker.name, money(report.total), "amber") +
      stat("Items sold", report.itemsSold) +
      stat("Transactions", report.transactions) +
      "</div>" +
      "</div>" +
      (report.breakdown.length > 1
        ? '<div class="panel"><h2>' +
          (report.period === "year" ? "By month" : "By day") +
          '</h2><div class="table-wrap"><table>' +
          "<thead><tr><th>" +
          (report.period === "year" ? "Month" : "Date") +
          '</th><th class="num">Items</th><th class="num">Transactions</th><th class="num">Amount</th></tr></thead><tbody>' +
          report.breakdown
            .map(function (b) {
              return (
                '<tr><td class="cell-strong">' +
                esc(breakdownKeyLabel(report.period, b.key)) +
                "</td>" +
                '<td class="num">' +
                b.quantity +
                '</td><td class="num">' +
                b.transactions +
                "</td>" +
                '<td class="num cell-strong">' +
                money(b.amount) +
                "</td></tr>"
              );
            })
            .join("") +
          "</tbody></table></div></div>"
        : "") +
      '<div class="panel"><h2>Products sold ' +
      esc(periodLabel(report)) +
      '</h2><div class="table-wrap"><table>' +
      '<thead><tr><th></th><th>Product</th><th class="num">Quantity</th><th class="num">Amount</th></tr></thead><tbody>' +
      (report.rows.length
        ? report.rows
            .map(function (r) {
              return (
                '<tr><td><img class="thumb" src="' +
                esc(r.image || "/assets/img/part-placeholder.svg") +
                '" alt=""></td>' +
                '<td class="cell-strong">' +
                esc(r.product_name) +
                '</td><td class="num">' +
                r.quantity +
                "</td>" +
                '<td class="num cell-strong">' +
                money(r.amount) +
                "</td></tr>"
              );
            })
            .join("")
        : '<tr><td colspan="4" class="table-empty">No sales in this period.</td></tr>') +
      "</tbody></table></div></div>" +
      '<div class="panel"><h2>Every transaction ' +
      esc(periodLabel(report)) +
      '</h2><div class="table-wrap"><table>' +
      '<thead><tr><th>Date</th><th>Time</th><th>Product</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Total</th></tr></thead><tbody>' +
      (report.detail.length
        ? report.detail
            .map(function (d) {
              return (
                "<tr><td>" +
                esc(d.sale_date) +
                "</td><td>" +
                timeOf(d.created_at) +
                "</td>" +
                '<td class="cell-strong">' +
                esc(d.product_name) +
                '</td><td class="num">' +
                d.quantity +
                "</td>" +
                '<td class="num">' +
                money(d.unit_price) +
                '</td><td class="num cell-strong">' +
                money(d.total) +
                "</td></tr>"
              );
            })
            .join("")
        : '<tr><td colspan="6" class="table-empty">No transactions in this period.</td></tr>') +
      "</tbody></table></div></div>";
    $("#view").innerHTML = html;

    $("#rep-worker").addEventListener("change", function (e) {
      reportsState.workerId = Number(e.target.value);
      loadWorkerReport(workers);
    });
    $("#view")
      .querySelectorAll(".period-tab")
      .forEach(function (btn) {
        btn.addEventListener("click", function () {
          reportsState.period = btn.getAttribute("data-period");
          reportsState.date = defaultDateFor(reportsState.period);
          loadWorkerReport(workers);
        });
      });
    $("#rep-prev").addEventListener("click", function () {
      reportsState.date = shiftDate(reportsState.date, reportsState.period, -1);
      loadWorkerReport(workers);
    });
    $("#rep-next").addEventListener("click", function () {
      reportsState.date = shiftDate(reportsState.date, reportsState.period, 1);
      loadWorkerReport(workers);
    });
    $("#rep-export").addEventListener("click", function () {
      downloadFile(
        "/api/sales/worker/" +
          s.workerId +
          "/export?period=" +
          s.period +
          "&date=" +
          encodeURIComponent(s.date),
      ).catch(function (err) {
        toast(err.message, true);
      });
    });
  }

  // ================= RECEIPTS =================
  var receiptsFilter = { from: "", to: "", search: "" };
  var receiptProductCache = null;

  function renderReceipts() {
    var qs =
      "?from=" +
      encodeURIComponent(receiptsFilter.from) +
      "&to=" +
      encodeURIComponent(receiptsFilter.to) +
      "&search=" +
      encodeURIComponent(receiptsFilter.search);
    api("/api/admin/receipts" + qs)
      .then(function (res) {
        var receipts = res.receipts;
        var html =
          '<div class="view-head"><h1>Receipts</h1>' +
          '<button class="btn btn-primary" id="new-receipt">＋ Create receipt</button></div>' +
          '<p class="view-sub">Issue receipts for companies or local buyers, and keep every one on file downloadable anytime.</p>' +
          '<div class="stats">' +
          stat("Receipts on file", receipts.length) +
          stat("Total value", money(res.totalAmount), "amber") +
          "</div>" +
          '<div class="panel"><div class="toolbar" style="margin-bottom:.9rem">' +
          '<input id="r-search" type="search" placeholder="Search buyer or receipt #…" value="' +
          esc(receiptsFilter.search) +
          '" style="max-width:240px">' +
          '<label class="cell-muted" style="font-size:.82rem">From <input id="r-from" type="date" value="' +
          esc(receiptsFilter.from) +
          '" style="width:auto"></label>' +
          '<label class="cell-muted" style="font-size:.82rem">To <input id="r-to" type="date" value="' +
          esc(receiptsFilter.to) +
          '" style="width:auto"></label>' +
          "</div>" +
          '<div class="table-wrap"><table><thead><tr><th>Receipt #</th><th>Date</th><th>Buyer</th><th>Type</th><th class="num">Total</th><th>Actions</th></tr></thead><tbody>' +
          (receipts.length
            ? receipts
                .map(function (r) {
                  return (
                    '<tr><td class="cell-strong">' +
                    esc(r.receipt_number) +
                    "</td>" +
                    "<td>" +
                    esc(r.created_at.slice(0, 10)) +
                    "</td>" +
                    "<td>" +
                    esc(r.buyer_name) +
                    "</td>" +
                    '<td><span class="badge badge-cat">' +
                    (r.buyer_type === "company" ? "Company" : "Individual") +
                    "</span></td>" +
                    '<td class="num cell-strong">' +
                    money(r.total) +
                    "</td>" +
                    '<td><div class="actions">' +
                    '<button class="btn btn-dark btn-xs" data-view-pdf="' +
                    r.id +
                    '">👁 View</button>' +
                    '<button class="btn btn-outline btn-xs" data-dl-pdf="' +
                    r.id +
                    '">⬇ Download</button>' +
                    "</div></td></tr>"
                  );
                })
                .join("")
            : '<tr><td colspan="6" class="table-empty">No receipts yet create the first one.</td></tr>') +
          "</tbody></table></div></div>";
        $("#view").innerHTML = html;

        $("#new-receipt").addEventListener("click", openReceiptModal);
        $("#r-search").addEventListener("input", function (e) {
          receiptsFilter.search = e.target.value;
          clearTimeout(renderReceipts._t);
          renderReceipts._t = setTimeout(renderReceipts, 300);
        });
        $("#r-from").addEventListener("change", function (e) {
          receiptsFilter.from = e.target.value;
          renderReceipts();
        });
        $("#r-to").addEventListener("change", function (e) {
          receiptsFilter.to = e.target.value;
          renderReceipts();
        });
        $("#view")
          .querySelectorAll("[data-view-pdf]")
          .forEach(function (btn) {
            btn.addEventListener("click", function () {
              viewFile(
                "/api/admin/receipts/" +
                  btn.getAttribute("data-view-pdf") +
                  "/pdf",
              ).catch(function (err) {
                toast(err.message, true);
              });
            });
          });
        $("#view")
          .querySelectorAll("[data-dl-pdf]")
          .forEach(function (btn) {
            btn.addEventListener("click", function () {
              downloadFile(
                "/api/admin/receipts/" +
                  btn.getAttribute("data-dl-pdf") +
                  "/pdf?download=1",
              ).catch(function (err) {
                toast(err.message, true);
              });
            });
          });
      })
      .catch(showError);
  }

  function ensureReceiptProducts() {
    if (receiptProductCache) return Promise.resolve(receiptProductCache);
    return api("/api/admin/products").then(function (res) {
      receiptProductCache = res.products;
      return receiptProductCache;
    });
  }

  function openReceiptModal() {
    ensureReceiptProducts()
      .then(function (products) {
        var modal = openModal(
          "<h2>Create receipt</h2>" +
            '<form id="receipt-form" class="form-grid">' +
            '<div class="form-row">' +
            '<label>Buyer type<select name="buyer_type"><option value="individual">Individual</option><option value="company">Company</option></select></label>' +
            '<label>Buyer name *<input name="buyer_name" required></label>' +
            "</div>" +
            '<div class="form-row">' +
            '<label>Phone<input name="buyer_phone"></label>' +
            '<label>Address<input name="buyer_address"></label>' +
            "</div>" +
            '<label>Notes<textarea name="notes" placeholder="Optional"></textarea></label>' +
            '<div class="form-col"><span>Items</span><div id="receipt-items"></div>' +
            '<button type="button" class="btn btn-outline btn-xs" id="add-item" style="margin-top:.5rem;width:fit-content">＋ Add item</button></div>' +
            '<div class="sale-summary-r">Total: <strong id="receipt-total">0 FCFA</strong></div>' +
            '<p class="form-error" id="receipt-error" hidden></p>' +
            '<div class="modal-actions">' +
            '<button type="button" class="btn btn-outline" id="cancel-receipt">Cancel</button>' +
            '<button type="submit" class="btn btn-primary">Create receipt</button>' +
            "</div></form>",
        );

        var itemsWrap = $("#receipt-items", modal);
        var rowCount = 0;

        function addRow() {
          rowCount++;
          var row = document.createElement("div");
          row.className = "receipt-item-row";
          row.innerHTML =
            '<div class="ri-name-wrap">' +
            '<input type="text" class="ri-name" placeholder="Search product or type custom item…" autocomplete="off">' +
            '<div class="ri-suggest" hidden></div>' +
            "</div>" +
            '<input type="number" class="ri-qty" min="1" value="1" placeholder="Qty">' +
            '<input type="number" class="ri-price" min="0" placeholder="Unit price">' +
            '<span class="ri-total">0</span>' +
            '<button type="button" class="ri-remove" title="Remove">✕</button>';
          itemsWrap.appendChild(row);

          var nameInput = row.querySelector(".ri-name");
          var suggestBox = row.querySelector(".ri-suggest");
          var qtyInput = row.querySelector(".ri-qty");
          var priceInput = row.querySelector(".ri-price");
          var totalSpan = row.querySelector(".ri-total");
          row.dataset.productId = "";

          function updateRowTotal() {
            var qty = Math.max(0, Number(qtyInput.value) || 0);
            var price = Math.max(0, Number(priceInput.value) || 0);
            totalSpan.textContent = money(qty * price);
            updateReceiptTotal();
          }
          qtyInput.addEventListener("input", updateRowTotal);
          priceInput.addEventListener("input", updateRowTotal);
          nameInput.addEventListener("input", function () {
            row.dataset.productId = "";
            var q = nameInput.value.trim().toLowerCase();
            if (!q) {
              suggestBox.hidden = true;
              return;
            }
            var matches = products
              .filter(function (p) {
                return (
                  p.name_en.toLowerCase().indexOf(q) !== -1 ||
                  (p.sku || "").toLowerCase().indexOf(q) !== -1
                );
              })
              .slice(0, 8);
            if (!matches.length) {
              suggestBox.hidden = true;
              return;
            }
            suggestBox.innerHTML = matches
              .map(function (p) {
                return (
                  '<div class="ri-suggest-item" data-id="' +
                  p.id +
                  '" data-price="' +
                  p.price +
                  '" data-name="' +
                  esc(p.name_en) +
                  '" data-sku="' +
                  esc(p.sku || "") +
                  '">' +
                  esc(p.name_en) +
                  (p.sku
                    ? ' <span class="cell-muted">· ' + esc(p.sku) + "</span>"
                    : "") +
                  "</div>"
                );
              })
              .join("");
            suggestBox.hidden = false;
          });
          suggestBox.addEventListener("click", function (e) {
            var item = e.target.closest(".ri-suggest-item");
            if (!item) return;
            nameInput.value = item.getAttribute("data-name");
            row.dataset.productId = item.getAttribute("data-id");
            row.dataset.sku = item.getAttribute("data-sku");
            priceInput.value = item.getAttribute("data-price");
            suggestBox.hidden = true;
            updateRowTotal();
          });
          document.addEventListener("click", function (e) {
            if (!row.contains(e.target)) suggestBox.hidden = true;
          });
          row
            .querySelector(".ri-remove")
            .addEventListener("click", function () {
              row.remove();
              updateReceiptTotal();
            });
        }

        function updateReceiptTotal() {
          var total = 0;
          itemsWrap
            .querySelectorAll(".receipt-item-row")
            .forEach(function (row) {
              var qty = Number(row.querySelector(".ri-qty").value) || 0;
              var price = Number(row.querySelector(".ri-price").value) || 0;
              total += qty * price;
            });
          $("#receipt-total", modal).textContent = money(total);
        }

        addRow();
        $("#add-item", modal).addEventListener("click", addRow);
        $("#cancel-receipt", modal).addEventListener("click", closeModal);

        $("#receipt-form", modal).addEventListener("submit", function (e) {
          e.preventDefault();
          var f = e.target;
          var items = [];
          itemsWrap
            .querySelectorAll(".receipt-item-row")
            .forEach(function (row) {
              var name = row.querySelector(".ri-name").value.trim();
              var qty = Number(row.querySelector(".ri-qty").value);
              var price = Number(row.querySelector(".ri-price").value);
              if (!name || !qty) return;
              var item = { quantity: qty, unit_price: price };
              if (row.dataset.productId)
                item.product_id = Number(row.dataset.productId);
              else item.product_name = name;
              items.push(item);
            });
          if (!items.length) {
            var el = $("#receipt-error", modal);
            el.textContent = "Add at least one item.";
            el.hidden = false;
            return;
          }
          api("/api/admin/receipts", {
            method: "POST",
            body: {
              buyer_type: f.buyer_type.value,
              buyer_name: f.buyer_name.value,
              buyer_phone: f.buyer_phone.value,
              buyer_address: f.buyer_address.value,
              notes: f.notes.value,
              items: items,
            },
          })
            .then(function (res) {
              closeModal();
              toast("Receipt " + res.receipt.receipt_number + " created");
              renderReceipts();
              viewFile("/api/admin/receipts/" + res.receipt.id + "/pdf").catch(
                function () {},
              );
            })
            .catch(function (err) {
              var el = $("#receipt-error", modal);
              el.textContent = err.message;
              el.hidden = false;
            });
        });
      })
      .catch(function (err) {
        toast(err.message, true);
      });
  }

  // ================= BRANCHES (shared cache) =================
  var branchesCache = null;
  function ensureBranches(force) {
    if (branchesCache && !force) return Promise.resolve(branchesCache);
    return api("/api/admin/branches").then(function (res) {
      branchesCache = res.branches;
      return branchesCache;
    });
  }

  // ================= PENDING APPROVAL =================
  function renderPending() {
    api("/api/admin/products/pending")
      .then(function (res) {
        var products = res.products;
        refreshPendingBadge();
        var html =
          '<div class="view-head"><h1>Pending Approval</h1></div>' +
          '<p class="view-sub">New inventory submitted by workers nothing here is visible to customers, workers\' sell lists, or reports until you approve it.</p>' +
          (products.length
            ? products
                .map(function (p) {
                  return (
                    '<div class="panel pending-card" data-id="' +
                    p.id +
                    '">' +
                    '<div class="pending-top">' +
                    '<img class="thumb-lg" src="' +
                    esc(p.image || "/assets/img/part-placeholder.svg") +
                    '" alt="">' +
                    '<div class="pending-info">' +
                    "<h2>" +
                    esc(p.name_en) +
                    "</h2>" +
                    '<p class="cell-muted">' +
                    esc(CATEGORIES[p.category] || p.category) +
                    (p.brand ? " · " + esc(p.brand) : "") +
                    (p.sku ? " · " + esc(p.sku) : "") +
                    "</p>" +
                    '<div class="pending-meta">' +
                    "<span><b>Price:</b> " +
                    money(p.price) +
                    "</span>" +
                    "<span><b>Quantity:</b> " +
                    p.quantity +
                    "</span>" +
                    "<span><b>Branch:</b> " +
                    esc(p.branch_name) +
                    "</span>" +
                    "<span><b>Submitted by:</b> " +
                    esc(p.created_by) +
                    "</span>" +
                    "<span><b>When:</b> " +
                    esc(p.created_at) +
                    "</span>" +
                    "</div>" +
                    (p.desc_en
                      ? '<p class="pending-desc">' + esc(p.desc_en) + "</p>"
                      : "") +
                    "</div></div>" +
                    '<div class="modal-actions" style="justify-content:flex-start;margin-top:1rem">' +
                    '<button class="btn btn-primary btn-xs" data-approve="' +
                    p.id +
                    '">✓ Approve — go live</button>' +
                    '<button class="btn btn-danger btn-xs" data-reject="' +
                    p.id +
                    '">✕ Reject</button>' +
                    "</div></div>"
                  );
                })
                .join("")
            : '<div class="panel"><p class="cell-muted">No submissions waiting you\'re all caught up.</p></div>');
        $("#view").innerHTML = html;

        $("#view").onclick = function (e) {
          var approveBtn = e.target.closest("[data-approve]");
          var rejectBtn = e.target.closest("[data-reject]");
          if (approveBtn) {
            api(
              "/api/admin/products/" +
                approveBtn.getAttribute("data-approve") +
                "/approve",
              { method: "POST" },
            )
              .then(function () {
                toast("Product approved — now live on the client site");
                renderPending();
              })
              .catch(function (err) {
                toast(err.message, true);
              });
          }
          if (rejectBtn) {
            if (
              !confirm(
                "Reject this submission? It will be permanently removed.",
              )
            )
              return;
            api(
              "/api/admin/products/" +
                rejectBtn.getAttribute("data-reject") +
                "/reject",
              { method: "POST" },
            )
              .then(function () {
                toast("Submission rejected");
                renderPending();
              })
              .catch(function (err) {
                toast(err.message, true);
              });
          }
        };
      })
      .catch(showError);
  }

  // ================= OUT OF STOCK =================
  function renderOutOfStock() {
    Promise.all([
      api("/api/admin/products?stock=out"),
      api("/api/admin/products?stock=low"),
    ])
      .then(function (res) {
        var out = res[0].products,
          low = res[1].products;
        var html =
          '<div class="view-head"><h1>Out of Stock</h1></div>' +
          '<p class="view-sub">Every zero-stock product across all branches, in one place not just a dashboard count.</p>' +
          '<div class="stats">' +
          stat("Out of stock", out.length, "red") +
          stat("Low stock (≤ " + LOW_STOCK + ")", low.length, "amber") +
          "</div>" +
          '<div class="panel"><h2>Out of stock (' +
          out.length +
          ')</h2><div class="table-wrap"><table>' +
          '<thead><tr><th></th><th>Product</th><th>Branch</th><th>Category</th><th class="num">Price</th><th>Restock</th></tr></thead><tbody>' +
          (out.length
            ? out
                .map(function (p) {
                  return outOfStockRow(p);
                })
                .join("")
            : '<tr><td colspan="6" class="table-empty">Nothing out of stock — good shape.</td></tr>') +
          "</tbody></table></div></div>" +
          '<div class="panel"><h2>Low stock — ≤ ' +
          LOW_STOCK +
          " left (" +
          low.length +
          ')</h2><div class="table-wrap"><table>' +
          '<thead><tr><th></th><th>Product</th><th>Branch</th><th class="num">Quantity left</th><th>Restock</th></tr></thead><tbody>' +
          (low.length
            ? low
                .map(function (p) {
                  return (
                    '<tr data-id="' +
                    p.id +
                    '"><td><img class="thumb" src="' +
                    esc(p.image || "/assets/img/part-placeholder.svg") +
                    '" alt=""></td>' +
                    '<td class="cell-strong">' +
                    esc(p.name_en) +
                    "</td><td>" +
                    esc(p.branch_name) +
                    "</td>" +
                    '<td class="num low-stock">' +
                    p.quantity +
                    "</td>" +
                    '<td><button class="btn btn-outline btn-xs" data-restock="' +
                    p.id +
                    '">Restock</button></td></tr>'
                  );
                })
                .join("")
            : '<tr><td colspan="5" class="table-empty">Nothing low on stock.</td></tr>') +
          "</tbody></table></div></div>";
        $("#view").innerHTML = html;

        $("#view").onclick = function (e) {
          var btn = e.target.closest("[data-restock]");
          if (!btn) return;
          var id = Number(btn.getAttribute("data-restock"));
          var product = out.concat(low).find(function (p) {
            return p.id === id;
          });
          if (product) openRestockModal(product, renderOutOfStock);
        };
      })
      .catch(showError);
  }

  function outOfStockRow(p) {
    return (
      '<tr data-id="' +
      p.id +
      '"><td><img class="thumb" src="' +
      esc(p.image || "/assets/img/part-placeholder.svg") +
      '" alt=""></td>' +
      '<td class="cell-strong">' +
      esc(p.name_en) +
      "</td><td>" +
      esc(p.branch_name) +
      "</td>" +
      '<td><span class="badge badge-cat">' +
      esc(CATEGORIES[p.category] || p.category) +
      "</span></td>" +
      '<td class="num">' +
      money(p.price) +
      "</td>" +
      '<td><button class="btn btn-outline btn-xs" data-restock="' +
      p.id +
      '">Restock</button></td></tr>'
    );
  }

  // ================= BRANCHES =================
  function renderBranches() {
    ensureBranches(true)
      .then(function (branches) {
        var html =
          '<div class="view-head"><h1>Branches</h1>' +
          '<button class="btn btn-primary" id="new-branch">＋ Add branch</button></div>' +
          '<p class="view-sub">Each branch tracks its own inventory. Workers sell from their own branch but can search stock at any branch.</p>' +
          '<div class="table-wrap panel"><table><thead><tr><th>Branch</th><th>City</th><th class="num">Products</th><th class="num">Out of stock</th><th class="num">Low stock</th><th class="num">Workers</th><th>Actions</th></tr></thead><tbody>' +
          (branches.length
            ? branches
                .map(function (b) {
                  return (
                    '<tr data-id="' +
                    b.id +
                    '">' +
                    '<td class="cell-strong">' +
                    esc(b.name) +
                    "</td><td>" +
                    esc(b.city) +
                    "</td>" +
                    '<td class="num">' +
                    b.product_count +
                    "</td>" +
                    '<td class="num' +
                    (b.out_of_stock ? " low-stock" : "") +
                    '">' +
                    b.out_of_stock +
                    "</td>" +
                    '<td class="num">' +
                    b.low_stock +
                    "</td>" +
                    '<td class="num">' +
                    b.worker_count +
                    "</td>" +
                    '<td><button class="btn btn-danger btn-xs" data-del-branch="' +
                    b.id +
                    '">Delete</button></td></tr>'
                  );
                })
                .join("")
            : '<tr><td colspan="7" class="table-empty">No branches yet.</td></tr>') +
          "</tbody></table></div>";
        $("#view").innerHTML = html;

        $("#new-branch").addEventListener("click", function () {
          var modal = openModal(
            '<h2>Add branch</h2><form id="branch-form" class="form-grid">' +
              '<label>Branch name *<input name="name" required placeholder="e.g. Douala Branch"></label>' +
              '<label>City<input name="city" placeholder="e.g. Douala"></label>' +
              '<p class="form-error" id="branch-error" hidden></p>' +
              '<div class="modal-actions"><button type="button" class="btn btn-outline" id="cancel-branch">Cancel</button>' +
              '<button type="submit" class="btn btn-primary">Add branch</button></div></form>',
          );
          $("#cancel-branch", modal).addEventListener("click", closeModal);
          $("#branch-form", modal).addEventListener("submit", function (e) {
            e.preventDefault();
            var f = e.target;
            api("/api/admin/branches", {
              method: "POST",
              body: { name: f.name.value, city: f.city.value },
            })
              .then(function () {
                closeModal();
                toast("Branch added");
                renderBranches();
              })
              .catch(function (err) {
                var el = $("#branch-error", modal);
                el.textContent = err.message;
                el.hidden = false;
              });
          });
        });

        $("#view").onclick = function (e) {
          var del = e.target.closest("[data-del-branch]");
          if (!del) return;
          if (!confirm("Delete this branch?")) return;
          api("/api/admin/branches/" + del.getAttribute("data-del-branch"), {
            method: "DELETE",
          })
            .then(function () {
              toast("Branch deleted");
              renderBranches();
            })
            .catch(function (err) {
              toast(err.message, true);
            });
        };
      })
      .catch(showError);
  }

  // ================= CATEGORIES =================
  function renderCategories() {
    ensureCategories(true)
      .then(function (categories) {
        var html =
          '<div class="view-head"><h1>Categories</h1>' +
          '<button class="btn btn-primary" id="new-category">＋ Add category</button></div>' +
          '<p class="view-sub">Used across the client site, workers app and product forms. Delete only removes a category once nothing uses it.</p>' +
          '<div class="panel"><div class="table-wrap"><table><thead><tr>' +
          '<th>Name (EN)</th><th>Nom (FR)</th><th>名称 (ZH)</th><th class="num">Products</th><th>Actions</th>' +
          "</tr></thead><tbody>" +
          (categories.length
            ? categories
                .map(function (c) {
                  return (
                    '<tr data-id="' +
                    c.id +
                    '">' +
                    '<td class="cell-strong">' +
                    esc(c.name_en) +
                    "</td>" +
                    "<td>" +
                    esc(c.name_fr) +
                    "</td>" +
                    "<td>" +
                    esc(c.name_zh) +
                    "</td>" +
                    '<td class="num">' +
                    c.product_count +
                    "</td>" +
                    '<td><button class="btn btn-danger btn-xs" data-del-cat="' +
                    c.id +
                    '"' +
                    (c.product_count ? ' disabled title="Still in use"' : "") +
                    ">Delete</button></td></tr>"
                  );
                })
                .join("")
            : '<tr><td colspan="5" class="table-empty">No categories yet.</td></tr>') +
          "</tbody></table></div></div>";
        $("#view").innerHTML = html;

        $("#new-category").addEventListener("click", function () {
          var modal = openModal(
            '<h2>Add category</h2><form id="category-form" class="form-grid">' +
              '<label>Name — English *<input name="name_en" required></label>' +
              '<label>Name — Français<input name="name_fr"></label>' +
              '<label>Name — 中文<input name="name_zh"></label>' +
              '<p class="form-error" id="category-error" hidden></p>' +
              '<div class="modal-actions"><button type="button" class="btn btn-outline" id="cancel-category">Cancel</button>' +
              '<button type="submit" class="btn btn-primary">Add category</button></div></form>',
          );
          $("#cancel-category", modal).addEventListener("click", closeModal);
          $("#category-form", modal).addEventListener("submit", function (e) {
            e.preventDefault();
            var f = e.target;
            api("/api/admin/categories", {
              method: "POST",
              body: {
                name_en: f.name_en.value,
                name_fr: f.name_fr.value,
                name_zh: f.name_zh.value,
              },
            })
              .then(function () {
                closeModal();
                toast("Category added");
                renderCategories();
              })
              .catch(function (err) {
                var el = $("#category-error", modal);
                el.textContent = err.message;
                el.hidden = false;
              });
          });
        });

        $("#view").onclick = function (e) {
          var del = e.target.closest("[data-del-cat]");
          if (!del || del.disabled) return;
          if (!confirm("Delete this category?")) return;
          api("/api/admin/categories/" + del.getAttribute("data-del-cat"), {
            method: "DELETE",
          })
            .then(function () {
              toast("Category deleted");
              renderCategories();
            })
            .catch(function (err) {
              toast(err.message, true);
            });
        };
      })
      .catch(showError);
  }

  // ================= SETTINGS =================
  function renderSettings() {
    api("/api/admin/settings")
      .then(function (res) {
        var s = res.settings;
        var html =
          '<div class="view-head"><h1>Settings</h1></div>' +
          '<div class="panel"><h2>Business contact shown on the client site</h2>' +
          '<form id="settings-form" class="form-grid">' +
          '<div class="form-row">' +
          '<label>Phone<input name="phone" value="' +
          esc(s.phone) +
          '"></label>' +
          '<label>WhatsApp number<input name="whatsapp" value="' +
          esc(s.whatsapp) +
          '"><span class="form-hint">With country code, e.g. +2376XXXXXXXX</span></label>' +
          "</div>" +
          '<div class="form-row">' +
          '<label>Email<input name="email" type="email" value="' +
          esc(s.email) +
          '"></label>' +
          '<label>Opening hours<input name="hours" value="' +
          esc(s.hours) +
          '"></label>' +
          "</div>" +
          '<label>Address<input name="address" value="' +
          esc(s.address) +
          '"></label>' +
          '<label>Facebook page (optional)<input name="facebook" type="url" value="' +
          esc(s.facebook) +
          '"></label>' +
          '<div class="modal-actions" style="justify-content:flex-start">' +
          '<button type="submit" class="btn btn-primary">Save updates the client site instantly</button></div>' +
          "</form></div>" +
          '<div class="panel"><h2>Change my password</h2>' +
          '<form id="pwchange-form" class="form-grid" style="max-width:420px">' +
          '<label>Current password<input name="current" type="password" required autocomplete="current-password"></label>' +
          '<label>New password<input name="next" type="password" required minlength="8" autocomplete="new-password"></label>' +
          '<div class="modal-actions" style="justify-content:flex-start">' +
          '<button type="submit" class="btn btn-dark">Change password</button></div>' +
          "</form></div>";
        $("#view").innerHTML = html;

        $("#settings-form").addEventListener("submit", function (e) {
          e.preventDefault();
          var f = e.target;
          api("/api/admin/settings", {
            method: "PUT",
            body: {
              phone: f.phone.value,
              whatsapp: f.whatsapp.value,
              email: f.email.value,
              hours: f.hours.value,
              address: f.address.value,
              facebook: f.facebook.value,
            },
          })
            .then(function () {
              toast("Saved — client site contact info updated");
            })
            .catch(function (err) {
              toast(err.message, true);
            });
        });

        $("#pwchange-form").addEventListener("submit", function (e) {
          e.preventDefault();
          var f = e.target;
          api("/api/auth/change-password", {
            method: "POST",
            body: { current: f.current.value, next: f.next.value },
          })
            .then(function () {
              f.reset();
              toast("Password changed");
            })
            .catch(function (err) {
              toast(err.message, true);
            });
        });
      })
      .catch(showError);
  }

  function showError(err) {
    $("#view").innerHTML =
      '<div class="panel"><p class="form-error">' +
      esc(err.message) +
      "</p></div>";
  }

  var views = {
    dashboard: renderDashboard,
    products: renderProducts,
    pending: renderPending,
    outofstock: renderOutOfStock,
    sales: renderSales,
    reports: renderReports,
    receipts: renderReceipts,
    workers: renderWorkers,
    branches: renderBranches,
    categories: renderCategories,
    settings: renderSettings,
  };

  // ---------- boot ----------
  if (token) {
    api("/api/auth/me")
      .then(function (data) {
        if (data.user.role !== "superadmin") return logout();
        enterApp();
      })
      .catch(function () {
        /* logout() already ran on 401 */
      });
  } else {
    showLogin();
  }
})();
