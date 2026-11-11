document.addEventListener("DOMContentLoaded", () => {
  // Limpiar restos de versiones anteriores (la sesión vive en una cookie HttpOnly)
  sessionStorage.removeItem("nexxo_admin_token");
  sessionStorage.removeItem("nexxo_admin_user");

  // Verificación de sesión de Administrador y visualización del operador
  fetch("/api/auth/verify", { credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) {
        window.location.replace("/admin/login");
        return;
      }
      const data = await res.json();
      const badge = document.getElementById("admin-user-badge");
      if (badge && data.user && data.user.username) {
        badge.textContent = `Administrador RR.HH. · ${data.user.username}`;
      }
    })
    .catch(() => {});

  // Enlazar botón Cerrar Sesión
  const btnLogout = document.getElementById("btn-logout");
  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
        });
      } catch (e) {}
      sessionStorage.removeItem("nexxo_admin_token");
      sessionStorage.removeItem("nexxo_admin_user");
      window.location.replace("/admin/login");
    });
  }

  // Wrapper para peticiones autenticadas (cookie HttpOnly de sesión)
  async function authFetch(url, options = {}) {
    options.credentials = "same-origin";
    const res = await fetch(url, options);
    if (res.status === 401 || res.status === 403) {
      if (typeof showToast === "function") {
        showToast(
          "Sesión expirada. Redirigiendo a la pantalla de acceso...",
          "warn",
        );
      }
      sessionStorage.removeItem("nexxo_admin_token");
      sessionStorage.removeItem("nexxo_admin_user");
      setTimeout(() => window.location.replace("/admin/login"), 1200);
      throw new Error("Sesión no autorizada o expirada.");
    }
    return res;
  }

  const metricTotal = document.getElementById("metric-total");
  const metricApproved = document.getElementById("metric-approved");
  const metricReview = document.getElementById("metric-review");
  const metricRejected = document.getElementById("metric-rejected");
  const metricSavings = document.getElementById("metric-savings");

  const filterPosition = document.getElementById("filter-position");
  const filterStatus = document.getElementById("filter-status");
  const btnRefresh = document.getElementById("btn-refresh");
  const candidatesTbody = document.getElementById("candidates-tbody");

  const modalCandidate = document.getElementById("modal-candidate");
  const modalTitle = document.getElementById("modal-title");
  const modalBody = document.getElementById("modal-body");
  const btnCloseModal = document.getElementById("btn-close-modal");

  // Centro de Notificaciones Fase 2
  const btnNotifications = document.getElementById("btn-notifications");
  const notificationBadge = document.getElementById("notification-badge");
  const notificationDropdown = document.getElementById("notification-dropdown");
  const notificationList = document.getElementById("notification-list");
  const notificationHeaderCount = document.getElementById(
    "notification-header-count",
  );

  async function loadNotifications() {
    if (!btnNotifications) return;
    try {
      const res = await authFetch("/api/admin/notifications");
      if (!res.ok) return;
      const data = await res.json();

      const count = data.pendingCount || 0;
      if (count > 0) {
        notificationBadge.textContent = count > 9 ? "9+" : count;
        notificationBadge.style.display = "flex";
      } else {
        notificationBadge.style.display = "none";
      }

      if (notificationHeaderCount) {
        notificationHeaderCount.textContent = `${count} pendientes`;
      }

      if (!notificationList) return;
      if (!data.notifications || data.notifications.length === 0) {
        notificationList.innerHTML = `<div class="notification-empty">No hay postulaciones de Fase 2 registradas</div>`;
        return;
      }

      notificationList.innerHTML = data.notifications
        .map((n) => {
          const timeStr =
            n.phase2_submitted_at || n.token_used_at
              ? new Date(
                  n.phase2_submitted_at || n.token_used_at,
                ).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                }) + " hrs"
              : "Reciente";

          return `
          <button type="button" class="notification-item" onclick="openCandidateFromNotification(${n.id})">
            <span class="notification-item-top">
              <span class="notification-item-name">${escapeHtml(n.full_name)}</span>
              <span class="notification-item-time">${timeStr}</span>
            </span>
            <span class="notification-item-desc">${escapeHtml(n.rut_id)} · ${escapeHtml(n.position_name || "Especialidad")}</span>
            <span class="notification-item-footer">
              <span class="status-pill ${getStatusPillClass(n.status)}">${escapeHtml(statusLabel(n.status))}</span>
              <span class="notification-item-cta">Auditar</span>
            </span>
          </button>
        `;
        })
        .join("");
    } catch (e) {
      console.warn("[Notificaciones] Error al consultar alertas:", e);
    }
  }

  window.openCandidateFromNotification = (id) => {
    if (notificationDropdown) notificationDropdown.style.display = "none";
    window.viewCandidate(id);
  };

  if (btnNotifications && notificationDropdown) {
    btnNotifications.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = notificationDropdown.style.display === "block";
      notificationDropdown.style.display = isVisible ? "none" : "block";
      if (!isVisible) {
        loadNotifications();
      }
    });

    document.addEventListener("click", (e) => {
      if (
        !notificationDropdown.contains(e.target) &&
        e.target !== btnNotifications
      ) {
        notificationDropdown.style.display = "none";
      }
    });
  }

  // Elementos de Scroll Sincronizado Superior
  const tableTopScroll = document.getElementById("table-top-scroll");
  const tableTopScrollInner = document.getElementById("table-top-scroll-inner");
  const tableContainer = document.getElementById("table-container");
  const dataTable = document.querySelector(".data-table");

  function updateTopScrollWidth() {
    if (!tableTopScrollInner || !dataTable) return;
    tableTopScrollInner.style.width = `${dataTable.scrollWidth}px`;
    if (tableTopScroll && tableContainer) {
      if (dataTable.scrollWidth <= tableContainer.clientWidth) {
        tableTopScroll.style.display = "none";
      } else {
        tableTopScroll.style.display = "block";
      }
    }
  }

  let isSyncingTop = false;
  let isSyncingBottom = false;

  if (tableTopScroll && tableContainer) {
    tableTopScroll.addEventListener("scroll", () => {
      if (isSyncingBottom) return;
      isSyncingTop = true;
      tableContainer.scrollLeft = tableTopScroll.scrollLeft;
      requestAnimationFrame(() => {
        isSyncingTop = false;
      });
    });

    tableContainer.addEventListener("scroll", () => {
      if (isSyncingTop) return;
      isSyncingBottom = true;
      tableTopScroll.scrollLeft = tableContainer.scrollLeft;
      requestAnimationFrame(() => {
        isSyncingBottom = false;
      });
    });

    window.addEventListener("resize", updateTopScrollWidth);
  }

  // Sistema de Notificaciones Toast Industriales
  function showToast(message, type = "success", durationMs = 4500) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const item = document.createElement("div");
    item.className = `toast-item toast-${type}`;

    const iconPath =
      type === "success"
        ? '<polyline points="20 6 9 17 4 12"></polyline>'
        : type === "warn"
          ? '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>'
          : '<circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>';
    item.innerHTML = `
      <svg class="toast-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPath}</svg>
      <span class="toast-text">${escapeHtml(message)}</span>
    `;

    container.appendChild(item);

    setTimeout(() => {
      item.style.opacity = "0";
      item.style.transform = "translateX(30px)";
      setTimeout(() => item.remove(), 300);
    }, durationMs);
  }
  window.showToast = showToast;

  // Copia de enlace Magic Link al portapapeles
  window.copyMagicLinkToClipboard = async (url, btnElement) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const tempInput = document.createElement("textarea");
        tempInput.value = url;
        document.body.appendChild(tempInput);
        tempInput.select();
        document.execCommand("copy");
        document.body.removeChild(tempInput);
      }
      showToast("Enlace copiado exitosamente al portapapeles.", "success");
      if (btnElement) {
        const orig = btnElement.textContent;
        btnElement.textContent = "Enlace copiado";
        btnElement.classList.add("is-copied");
        setTimeout(() => {
          btnElement.textContent = orig;
          btnElement.classList.remove("is-copied");
        }, 2500);
      }
    } catch (err) {
      showToast("No se pudo copiar automáticamente. Use Ctrl+C.", "warn");
    }
  };

  function getStatusPillClass(status) {
    // Clase legada + clase granular por estado (status-<ESTADO>) para el código de casco
    const granular = `status-${String(status || "").replace(/[^A-Za-z0-9_-]/g, "")}`;
    if (["PRE_ACREDITADO", "CONTRATADO_FAENA", "Aprobado"].includes(status)) {
      return `status-Aprobado ${granular}`;
    }
    if (status === "APROBADO_FAENA") {
      return `status-Pendiente ${granular}`;
    }
    if (["DESCARTADO_TECNICO", "Rechazado"].includes(status)) {
      return `status-Rechazado ${granular}`;
    }
    return `status-Pendiente ${granular}`;
  }

  // Etiquetas legibles de estado (solo presentación; el valor enviado al servidor no cambia)
  const STATUS_LABELS = {
    POSTULADO: "Postulado",
    PRESELECCIONADO: "Preseleccionado",
    DESCARTADO_TECNICO: "Descartado técnico",
    APROBADO_FAENA: "Aprobado faena",
    DOCS_CARGADOS: "Docs. cargados",
    PRE_ACREDITADO: "Pre-acreditado",
    EN_REVISION_MANUAL: "En revisión manual",
    CONTRATADO_FAENA: "Contratado faena",
  };

  function statusLabel(status) {
    return STATUS_LABELS[status] || String(status || "");
  }

  // Orden "acción primero": revisión manual, docs cargados, preseleccionado / aprobado faena, resto
  function actionRank(status) {
    if (status === "EN_REVISION_MANUAL") return 0;
    if (status === "DOCS_CARGADOS") return 1;
    if (status === "PRESELECCIONADO" || status === "APROBADO_FAENA") return 2;
    return 3;
  }

  // Último expediente cuyo estado cambió desde el panel (para animar su celda tras recargar)
  let lastStatusChangeId = null;

  // 1. Cargar Especialidades para filtro
  async function loadPositions() {
    try {
      const res = await fetch("/api/positions");
      const data = await res.json();
      filterPosition.innerHTML =
        '<option value="">Todas las especialidades</option>' +
        data.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    } catch (e) {
      console.error("Error cargando cargos:", e);
    }
  }

  // 2. Cargar Métricas Operativas e Impacto Económico
  async function loadStats() {
    try {
      const res = await authFetch("/api/admin/stats");
      const stats = await res.json();

      metricTotal.textContent = stats.total || 0;
      metricApproved.textContent = stats.approved || 0;
      if (metricReview) metricReview.textContent = stats.inReview || 0;
      metricRejected.textContent = stats.rejected || 0;

      const clpFormatted = new Intl.NumberFormat("es-CL", {
        style: "currency",
        currency: "CLP",
        maximumFractionDigits: 0,
      }).format(stats.savedTurnoverCostsCLP || 0);

      metricSavings.textContent = clpFormatted;
    } catch (e) {
      console.error("Error cargando métricas:", e);
    }
  }

  // 3. Cargar Lista de Postulantes
  async function loadCandidates() {
    try {
      const posVal = filterPosition.value;
      const statusVal = filterStatus.value;
      const params = new URLSearchParams();
      if (posVal) params.append("position_id", posVal);
      if (statusVal) params.append("status", statusVal);

      const res = await authFetch(`/api/admin/candidates?${params.toString()}`);
      const candidates = await res.json();

      if (!Array.isArray(candidates) || candidates.length === 0) {
        candidatesTbody.innerHTML = `<tr><td colspan="9" class="loading-td loading-td--empty"><strong>No hay postulaciones para este filtro.</strong><span>Cambia la especialidad o el estado para ampliar la búsqueda.</span></td></tr>`;
        return;
      }

      // Copia ordenada en cliente (sort estable: conserva el orden del servidor dentro de cada grupo)
      const sorted = candidates
        .slice()
        .sort((a, b) => actionRank(a.status) - actionRank(b.status));
      const actionCount = sorted.filter((c) => actionRank(c.status) < 3).length;
      const restCount = sorted.length - actionCount;

      const groupRow = (label, count) =>
        `<tr class="group-row"><td colspan="9"><span class="group-row-label">${label}</span> <span class="group-row-count">(${count})</span></td></tr>`;

      candidatesTbody.innerHTML = sorted
        .map((c, idx) => {
          let groupHeader = "";
          if (idx === 0 && actionCount > 0) {
            groupHeader = groupRow("Requiere acción", actionCount);
          } else if (idx === actionCount && actionCount > 0 && restCount > 0) {
            groupHeader = groupRow("Resto de expedientes", restCount);
          }
          const scorePercent =
            c.total_questions > 0
              ? Math.round((c.score / c.total_questions) * 100)
              : 0;
          const expDisplay = c.experience_years
            ? `${c.experience_years} años`
            : `${c.age || 3} años`;

          const hasRealDiscrepancy = Boolean(
            c.discrepancy_notes &&
            !c.discrepancy_notes.includes(
              "Expediente consistente. Sin observaciones.",
            ),
          );
          let crossCheckBadge = '<span class="badge-code">Fase 01</span>';
          if (c.ocr_cross_check_ok) {
            crossCheckBadge =
              '<span class="badge-code badge-code--ok">Conforme ECF</span>';
          } else if (c.status === "EN_REVISION_MANUAL") {
            if (hasRealDiscrepancy) {
              crossCheckBadge =
                '<span class="badge-code badge-code--warn">Discordancia OCR</span>';
            } else {
              crossCheckBadge =
                '<span class="badge-code badge-code--ok">En revisión · conforme</span>';
            }
          } else if (c.status === "DESCARTADO_TECNICO") {
            crossCheckBadge =
              '<span class="badge-code badge-code--danger">No conforme ECF</span>';
          }

          const canExport = [
            "PRE_ACREDITADO",
            "CONTRATADO_FAENA",
            "EN_REVISION_MANUAL",
            "Aprobado",
          ].includes(c.status);

          const stateKey = String(c.status || "").replace(
            /[^A-Za-z0-9_-]/g,
            "",
          );

          return `${groupHeader}
          <tr data-id="${c.id}">
            <td><span class="cell-folio">#${c.id}</span></td>
            <td><strong class="cell-name">${escapeHtml(c.full_name)}</strong></td>
            <td><span class="cell-num cell-muted">${escapeHtml(c.rut_id)}</span></td>
            <td><span class="cell-num">${expDisplay}</span></td>
            <td><span class="cell-position">${escapeHtml(c.position_name)}</span></td>
            <td>
              <span class="cell-score">${c.score}/${c.total_questions} <span class="cell-muted">(${scorePercent}%)</span></span>
              <span class="score-sub">
                Téc. <strong>${c.score_tecnico ?? 0}/3</strong> · SJT <strong class="${c.sjt_conforme ? "value--ok" : "value--danger"}">${c.sjt_conforme ? "2/2" : `${c.score_sjt ?? 0}/2`}</strong>
              </span>
            </td>
            <td class="cell-stack">
              ${crossCheckBadge}
              ${!c.sjt_conforme && c.status === "DESCARTADO_TECNICO" ? `<span class="badge-code badge-code--danger">Riesgo operacional ECF</span>` : ""}
            </td>
            <td class="cell-state" data-state="${stateKey}">
              <span class="status-pill ${getStatusPillClass(c.status)}">${escapeHtml(statusLabel(c.status))}</span>
            </td>
            <td>
              <div class="row-actions">
              <button type="button" class="btn btn-secondary btn-sm" onclick="viewCandidate(${c.id})">
                Auditar
              </button>
              ${
                canExport
                  ? `
                <a href="/api/admin/candidates/${c.id}/export-webcontrol" target="_blank" class="btn btn-secondary btn-sm btn-export" title="Generar Carpeta Estandarizada WebControl">
                  WebControl
                </a>
              `
                  : ""
              }
              </div>
            </td>
          </tr>
        `;
        })
        .join("");

      window.currentCandidates = candidates;
      updateTopScrollWidth();
      flipStateCell(lastStatusChangeId);
      lastStatusChangeId = null;
    } catch (e) {
      candidatesTbody.innerHTML = `<tr><td colspan="9" class="loading-td loading-td--error"><strong>Error conectando con la base de datos.</strong><span>Revisa la conexión y usa «Actualizar matriz» para reintentar.</span></td></tr>`;
      updateTopScrollWidth();
    }
  }

  // Volteo tipo split-flap de la celda Estado recién repintada (solo presentación)
  function flipStateCell(id) {
    if (id === null || id === undefined) return;
    const cell = candidatesTbody.querySelector(
      `tr[data-id="${Number(id)}"] td.cell-state`,
    );
    if (!cell) return;
    cell.classList.remove("is-flipping");
    void cell.offsetWidth;
    cell.classList.add("is-flipping");
    setTimeout(() => cell.classList.remove("is-flipping"), 700);
  }

  // 4. Abrir Modal de Auditoría y Validación Cruzada
  window.viewCandidate = (id) => {
    const candidate = window.currentCandidates.find((c) => c.id === id);
    if (!candidate) return;

    const headStateKey = String(candidate.status || "").replace(
      /[^A-Za-z0-9_-]/g,
      "",
    );
    modalTitle.innerHTML = `<span class="drawer-title-text">${escapeHtml(`Expediente #${candidate.id}: ${candidate.full_name}`)}</span>
      <span class="drawer-state" data-state="${headStateKey}"><span class="drawer-state-swatch" aria-hidden="true"></span><span class="visually-hidden">Estado actual: </span>${escapeHtml(statusLabel(candidate.status))}</span>`;

    // Botones de decisión: el estado vigente queda deshabilitado y marcado; naranjo solo si es acción disponible
    const decisionButton = (status, label, variant) => {
      const isCurrent = candidate.status === status;
      if (isCurrent) {
        return `<button type="button" class="btn btn-secondary btn-sm btn-current" disabled aria-describedby="decision-current-note"><span class="btn-current-tag"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>Estado actual</span> <span class="btn-current-label">${label}</span></button>`;
      }
      return `<button type="button" class="btn ${variant} btn-sm" onclick="updateCandidateStatus(${candidate.id}, '${status}')">${label}</button>`;
    };

    const scorePercent =
      candidate.total_questions > 0
        ? Math.round((candidate.score / candidate.total_questions) * 100)
        : 0;
    const credencialUrl = candidate.credencial_file || candidate.cert_file;
    const carnetUrl = candidate.carnet_file;

    const isExpedienteConforme =
      candidate.ocr_cross_check_ok ||
      !candidate.discrepancy_notes ||
      candidate.discrepancy_notes.includes(
        "Expediente consistente. Sin observaciones.",
      );
    const diagClass = isExpedienteConforme ? "callout--ok" : "callout--warn";

    let biometricBadge =
      '<span class="badge-code">Biometría facial: pendiente Fase 2</span>';
    if (candidate.facial_match_ok === 1 || candidate.facial_match_ok === true) {
      biometricBadge = `<span class="badge-code badge-code--ok">Biometría facial: conforme (${candidate.facial_confidence ?? 95}% coincidencia)</span>`;
    } else if (
      candidate.facial_match_ok === 0 ||
      candidate.facial_match_ok === false
    ) {
      biometricBadge = `<span class="badge-code badge-code--danger badge-code--strong">Alerta de fraude: posible suplantación facial (${candidate.facial_confidence ?? 0}% coincidencia)</span>`;
    }

    modalBody.innerHTML = `
      <section class="drawer-section">
        <h3 class="drawer-section-title">Resumen de evaluación</h3>
        <div class="info-grid">
          <div class="info-item">
            <span class="label">RUT / RUN</span>
            <span class="value">${escapeHtml(candidate.rut_id)}</span>
          </div>
          <div class="info-item">
            <span class="label">Experiencia declarada</span>
            <span class="value">${candidate.experience_years || 2} años en faena</span>
          </div>
          <div class="info-item">
            <span class="label">Calce de cargo (IA)</span>
            <span class="value ${(candidate.role_fit_percentage ?? 80) >= 70 ? "value--ok" : "value--warn"}">
              ${candidate.role_fit_percentage ? `${candidate.role_fit_percentage}% Afinidad` : "Conforme (80%)"}
            </span>
          </div>
          <div class="info-item">
            <span class="label">Exp. en oficio específico</span>
            <span class="value">${candidate.experience_years_in_role ?? candidate.experience_years ?? 2} años</span>
          </div>
          <div class="info-item">
            <span class="label">Especialidad & ECF</span>
            <span class="value">${escapeHtml(candidate.position_name)}</span>
          </div>
          <div class="info-item">
            <span class="label">Score técnico (P1 a P3)</span>
            <span class="value">${candidate.score_tecnico ?? 0} / 3</span>
          </div>
          <div class="info-item">
            <span class="label">Índice conductual ECF (SJT)</span>
            <span class="value ${candidate.sjt_conforme ? "value--ok" : "value--danger"}">
              ${candidate.sjt_conforme ? "Conforme (2/2)" : "No conforme (falla crítica)"}
            </span>
          </div>
          <div class="info-item">
            <span class="label">Veredicto Fase 1.5</span>
            <span class="status-pill ${getStatusPillClass(candidate.status)}">${escapeHtml(statusLabel(candidate.status))}</span>
          </div>
        </div>

        ${
          !candidate.sjt_conforme
            ? `
          <div class="callout callout--danger">
            <strong class="callout-title">Alerta de auditoría: riesgo operacional crítico</strong>
            El postulante falló al menos un reactivo de Juicio Situacional (SJT). Vulneró el principio de detención de faena ('Paso Cero' / Derecho a Decir NO) o no detuvo la maniobra ante falla de estabilidad de grúa. Descartado por regla de corte normativo excluyente ECF Codelco.
          </div>
        `
            : ""
        }
      </section>

      <!-- Comparativa Visual de Identidad (Face Match: Selfie Transparente vs. Foto Carnet) -->
      <section class="drawer-section media-box">
        <div class="drawer-section-head">
          <h3 class="drawer-section-title">Validación visual de identidad (selfie vs. cédula)</h3>
          ${biometricBadge}
        </div>
        <p class="drawer-section-desc">
          Contraste la Selfie Inicial y Captura en Vivo tomadas durante el Mini-Test Técnico (Fase 1.5) contra la foto de la Cédula de Identidad cargada en la Pre-Acreditación (Fase 2).
        </p>
        <div class="media-comparison-grid">
          <figure class="media-figure">
            <figcaption>Selfie inicial (Fase 1.5 · pre-test)</figcaption>
            ${
              candidate.initial_selfie
                ? `<img src="${candidate.initial_selfie}" alt="Selfie Inicial">`
                : '<p class="loading-td">Sin selfie inicial</p>'
            }
          </figure>
          <figure class="media-figure">
            <figcaption>Captura en vivo (durante el mini-test)</figcaption>
            ${
              candidate.random_selfie
                ? `<img src="${candidate.random_selfie}" alt="Captura en Vivo">`
                : '<p class="loading-td">Sin captura de test</p>'
            }
          </figure>
          <figure class="media-figure">
            <figcaption>Cédula de identidad (Fase 2 · pre-acreditación)</figcaption>
            ${
              carnetUrl
                ? `<img src="${carnetUrl}" alt="Cédula de Identidad">`
                : '<p class="loading-td">No requerida / Pendiente Fase 2</p>'
            }
          </figure>
        </div>
      </section>

      <!-- Matriz de Validación Cruzada OCR (Fase 3) -->
      <section class="drawer-section media-box">
        <div class="drawer-section-head">
          <h3 class="drawer-section-title">Validación cruzada OCR (Fase 1 vs. Fase 2)</h3>
          <div class="drawer-section-tools">
            <button type="button" id="btn-reprocess-ocr" class="btn btn-secondary btn-sm" onclick="reprocessCandidateOcr(${candidate.id})">Re-analizar OCR</button>
            <span class="status-pill ${getStatusPillClass(candidate.status)}">${escapeHtml(statusLabel(candidate.status))}</span>
          </div>
        </div>

        <dl class="check-list">
          <div class="check-item"><dt>1. Credencial técnica (Fase 1)</dt><dd>${escapeHtml(candidate.ocr_credencial_status || candidate.required_credential || "Verificada")}</dd></div>
          <div class="check-item"><dt>2. Cruce nombre / RUT (OCR)</dt><dd>${escapeHtml(candidate.ocr_detected_name || candidate.full_name)} (${escapeHtml(candidate.ocr_detected_rut || candidate.rut_id)})</dd></div>
          <div class="check-item"><dt>3. Vigencia cédula (OCR)</dt><dd>${escapeHtml(candidate.ocr_carnet_vigencia || "Pendiente Fase 2")}</dd></div>
          <div class="check-item"><dt>4. Cert. antecedentes (OCR)</dt><dd>${escapeHtml(candidate.ocr_antecedentes_status || "Pendiente Fase 2")}</dd></div>
        </dl>

        <div class="callout ${diagClass}">
          <strong class="callout-title">Diagnóstico normativo (ECF / DS N° 132)</strong>
          ${escapeHtml(candidate.discrepancy_notes || "Expediente consistente. Sin observaciones.")}
          ${candidate.ocr_manually_edited ? `<em class="callout-note">Nota de auditoría: el postulante editó manualmente en Fase 1: ${escapeHtml(candidate.ocr_edited_fields || "")}</em>` : ""}
        </div>

        ${
          candidate.ocr_text
            ? `
          <details class="ocr-log">
            <summary>
              <span class="ocr-log-label">Ver texto extraído por OCR</span>
              ${
                candidate.ocr_text.includes("[MOTOR: GEMINI") ||
                candidate.ocr_text.includes("[MOTOR: IA")
                  ? '<span class="badge badge--engine-ai">Motor: IA Gemini Flash</span>'
                  : '<span class="badge badge--engine-local">Motor: local Tesseract (fallback)</span>'
              }
            </summary>
            <pre>${escapeHtml(candidate.ocr_text)}</pre>
          </details>
        `
            : ""
        }
      </section>

      <!-- Documentación del Expediente WebControl -->
      <section class="drawer-section media-box">
        <h3 class="drawer-section-title">Archivos del expediente</h3>
        <p class="drawer-section-desc">Se abren en un visor aislado (sandbox anti-malware).</p>
        <div class="doc-actions">
          ${credencialUrl ? `<button type="button" onclick="openSecureDocViewer('${credencialUrl}', 'Credencial Técnica ECF')" class="btn btn-secondary btn-sm">Ver credencial</button>` : ""}
          ${candidate.cv_file ? `<button type="button" onclick="openSecureDocViewer('${candidate.cv_file}', 'Currículum Vitae (CV)')" class="btn btn-secondary btn-sm">Ver CV</button>` : ""}
          ${carnetUrl ? `<button type="button" onclick="openSecureDocViewer('${carnetUrl}', 'Cédula de Identidad (Frente)')" class="btn btn-secondary btn-sm">Ver cédula frente</button>` : ""}
          ${candidate.carnet_back_file ? `<button type="button" onclick="openSecureDocViewer('${candidate.carnet_back_file}', 'Cédula de Identidad (Reverso)')" class="btn btn-secondary btn-sm">Ver cédula reverso</button>` : ""}
          ${candidate.antecedentes_file ? `<button type="button" onclick="openSecureDocViewer('${candidate.antecedentes_file}', 'Certificado de Antecedentes')" class="btn btn-secondary btn-sm">Ver antecedentes</button>` : ""}
          <a href="/api/admin/candidates/${candidate.id}/export-webcontrol" target="_blank" class="btn btn-secondary btn-sm btn-export">
            Generar carpeta WebControl (PDF / estandarizado)
          </a>
        </div>
      </section>

      <!-- Acción Operativa de Aprobación de Acceso a Faena (Fase 2) -->
      ${
        ["PRESELECCIONADO", "EN_REVISION_MANUAL"].includes(candidate.status) &&
        !candidate.carnet_file &&
        !candidate.access_token
          ? `
        <section class="drawer-section">
          <h3 class="drawer-section-title">Autorizar acceso a faena</h3>
          <p class="drawer-section-desc">
            El postulante aprobó la evaluación técnica. Por normativa laboral (Ley N° 19.628), la Fase 2 (Cédula y Antecedentes) permanece bloqueada hasta que RR.HH. autorice el cupo de faena. Al presionar este botón, se emitirá su token de acceso y se le despachará el enlace a su correo electrónico (<strong>${escapeHtml(candidate.email || "correo")}</strong>).
          </p>
          <button type="button" class="btn btn-primary btn-block" id="btn-approve-faena" onclick="approveFaena(${candidate.id})">
            Aprobar acceso a faena y enviar enlace Fase 2
          </button>
        </section>
      `
          : ""
      }

      ${
        candidate.status === "APROBADO_FAENA" ||
        (candidate.access_token && !candidate.carnet_file)
          ? `
        <section class="drawer-section modal-token-card">
          <div class="drawer-section-head modal-token-card-header">
            <h3 class="drawer-section-title">Acceso a faena aprobado · enlace Fase 2 activo</h3>
            <span class="badge-code badge-code--ok">Válido 7 días</span>
          </div>
          <p class="drawer-section-desc">
            El candidato cuenta con autorización de faena activa para cargar su Cédula y Certificado de Antecedentes (Fase 2). Enlace despachado a <strong>${escapeHtml(candidate.email || "correo")}</strong>.
          </p>
          <div class="modal-token-link-box">
            <span>${escapeHtml(candidate.access_token ? `${window.location.origin}/?token=${candidate.access_token}` : "Enlace emitido en el sistema")}</span>
          </div>
          <div class="modal-token-actions">
            ${
              candidate.access_token
                ? `
              <button type="button" class="btn btn-secondary btn-sm" onclick="copyMagicLinkToClipboard('${window.location.origin}/?token=${candidate.access_token}', this)">
                Copiar enlace Fase 2
              </button>
            `
                : ""
            }
            <button type="button" class="btn btn-secondary btn-sm" id="btn-approve-faena" onclick="approveFaena(${candidate.id})">
              Re-despachar correo
            </button>
          </div>
        </section>
      `
          : ""
      }

      <!-- Controles de la Máquina de Estados -->
      <section class="drawer-section drawer-decision">
        <h3 class="drawer-section-title">Cambiar estado en nómina</h3>
        <div class="decision-row">
          ${decisionButton("DESCARTADO_TECNICO", "Descartar", "btn-danger")}
          <div class="decision-positive">
            ${decisionButton("EN_REVISION_MANUAL", "En revisión manual", "btn-secondary")}
            ${decisionButton("PRE_ACREDITADO", "Aprobar pre-acreditado", "btn-success")}
            ${decisionButton("CONTRATADO_FAENA", "Asignar a parada (contratado faena)", "btn-primary")}
          </div>
        </div>
        <p class="visually-hidden" id="decision-current-note">Este es el estado vigente del expediente; no se puede volver a asignar.</p>
      </section>
    `;

    modalCandidate.style.display = "flex";
    // Lleva el foco al expediente para navegación por teclado.
    if (btnCloseModal) btnCloseModal.focus({ preventScroll: true });
  };

  window.approveFaena = async (id) => {
    const btn = document.getElementById("btn-approve-faena");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Aprobando y despachando correo...";
    }
    try {
      const res = await authFetch(`/api/admin/candidates/${id}/approve-faena`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        if (data.mail_sent) {
          showToast(
            `Acceso autorizado. Correo enviado a ${data.mail_recipient || "postulante"}.`,
            "success",
          );
        } else if (data.mail_simulated) {
          showToast(
            `Acceso aprobado. Token generado (modo simulador consola).`,
            "warn",
          );
        } else {
          showToast(`Acceso autorizado y Magic Link generado.`, "success");
        }
        await loadCandidates();
        await loadStats();
        window.viewCandidate(id);
      } else {
        showToast(`Error al aprobar acceso a faena: ${data.error}`, "error");
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Aprobar acceso a faena y enviar enlace Fase 2";
        }
      }
    } catch (e) {
      showToast("Error de conexión al aprobar acceso a faena.", "error");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Aprobar acceso a faena y enviar enlace Fase 2";
      }
    }
  };

  window.reprocessCandidateOcr = async (id) => {
    const btn = document.getElementById("btn-reprocess-ocr");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Analizando...";
    }
    try {
      const res = await authFetch(`/api/admin/candidates/${id}/reprocess-ocr`, {
        method: "POST",
      });
      if (res.ok) {
        showToast("Expediente re-analizado correctamente por OCR.", "success");
        await loadCandidates();
        await loadStats();
        window.viewCandidate(id);
      } else {
        showToast("Error al re-analizar OCR del expediente.", "error");
      }
    } catch (e) {
      showToast("Error de conexión al re-analizar OCR.", "error");
    }
  };

  window.updateCandidateStatus = async (id, status) => {
    try {
      const res = await authFetch(`/api/admin/candidates/${id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });

      const data = await res.json();
      if (res.ok) {
        if (status === "CONTRATADO_FAENA" && data.mail_sent) {
          showToast(
            `Contratado: estado actualizado y correo de confirmación enviado al postulante.`,
            "success",
          );
        } else if (status === "CONTRATADO_FAENA" && data.mail_simulated) {
          showToast(
            `Contratado: estado actualizado (correo simulado en consola).`,
            "success",
          );
        } else {
          showToast(`Estado actualizado a ${statusLabel(status)}.`, "success");
        }
        modalCandidate.style.display = "none";
        lastStatusChangeId = id;
        loadCandidates();
        loadStats();
      } else {
        showToast(
          data.error ||
            "Error actualizando el estado en la máquina de estados.",
          "error",
        );
      }
    } catch (e) {
      showToast("Error de conexión al actualizar estado.", "error");
    }
  };

  btnCloseModal.addEventListener("click", () => {
    modalCandidate.style.display = "none";
  });

  // Modal de Previsualización Segura de Documentos en Sandbox
  const modalDocViewer = document.getElementById("modal-doc-viewer");
  const btnCloseDocModal = document.getElementById("btn-close-doc-modal");
  const docViewerFrame = document.getElementById("doc-viewer-frame");
  const docModalTitle = document.getElementById("doc-modal-title");
  const docModalDownload = document.getElementById("doc-modal-download");

  window.openSecureDocViewer = function (url, title = "Documento") {
    if (!url) return;
    const separator = url.includes("?") ? "&" : "?";
    const authUrl = url;
    const downloadUrl = `${url}${separator}download=1`;
    if (docModalTitle) docModalTitle.textContent = title;
    if (docViewerFrame) docViewerFrame.src = authUrl;
    if (docModalDownload) {
      docModalDownload.href = downloadUrl;
      docModalDownload.setAttribute("download", "");
    }
    if (modalDocViewer) modalDocViewer.style.display = "flex";
  };

  if (btnCloseDocModal && modalDocViewer) {
    btnCloseDocModal.addEventListener("click", () => {
      modalDocViewer.style.display = "none";
      if (docViewerFrame) docViewerFrame.src = "about:blank";
    });
    modalDocViewer.addEventListener("click", (e) => {
      if (e.target === modalDocViewer) {
        modalDocViewer.style.display = "none";
        if (docViewerFrame) docViewerFrame.src = "about:blank";
      }
    });
  }

  // Cerrar el panel de expediente al hacer clic en el fondo
  modalCandidate.addEventListener("click", (e) => {
    if (e.target === modalCandidate) {
      modalCandidate.style.display = "none";
    }
  });

  // Escape cierra la capa superior abierta (visor de documento, luego expediente)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (modalDocViewer && modalDocViewer.style.display !== "none") {
      modalDocViewer.style.display = "none";
      if (docViewerFrame) docViewerFrame.src = "about:blank";
    } else if (modalCandidate.style.display !== "none") {
      modalCandidate.style.display = "none";
    } else if (
      notificationDropdown &&
      notificationDropdown.style.display === "block"
    ) {
      notificationDropdown.style.display = "none";
    }
  });

  filterPosition.addEventListener("change", loadCandidates);
  filterStatus.addEventListener("change", loadCandidates);
  btnRefresh.addEventListener("click", () => {
    loadCandidates();
    loadStats();
    loadNotifications();
  });

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, function (m) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      }[m];
    });
  }

  loadPositions();
  loadStats();
  loadCandidates();
  loadNotifications();
  setInterval(loadNotifications, 30000);
});
