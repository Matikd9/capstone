document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const metricTotal = document.getElementById('metric-total');
  const metricApproved = document.getElementById('metric-approved');
  const metricRejected = document.getElementById('metric-rejected');
  const metricSavings = document.getElementById('metric-savings');

  const filterPosition = document.getElementById('filter-position');
  const filterStatus = document.getElementById('filter-status');
  const btnRefresh = document.getElementById('btn-refresh');

  const candidatesTbody = document.getElementById('candidates-tbody');

  // Modal DOM
  const modalCandidate = document.getElementById('modal-candidate');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');
  const btnCloseModal = document.getElementById('btn-close-modal');

  let positionsMap = {};

  // 1. Cargar Cargos para filtro
  async function loadPositions() {
    try {
      const res = await fetch('/api/positions');
      const data = await res.json();
      data.forEach(p => { positionsMap[p.id] = p.name; });
      filterPosition.innerHTML = '<option value="">Todos los cargos</option>' +
        data.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    } catch (e) {
      console.error('Error cargando cargos:', e);
    }
  }

  // 2. Cargar Métricas e Impacto Económico
  async function loadStats() {
    try {
      const res = await fetch('/api/admin/stats');
      const stats = await res.json();

      metricTotal.textContent = stats.total || 0;
      metricApproved.textContent = stats.approved || 0;
      metricRejected.textContent = stats.rejected || 0;

      // Formato CLP: $XX.000.000 CLP
      const clpFormatted = new Intl.NumberFormat('es-CL', {
        style: 'currency',
        currency: 'CLP',
        maximumFractionDigits: 0
      }).format(stats.savedTurnoverCostsCLP || 0);

      metricSavings.textContent = clpFormatted;
    } catch (e) {
      console.error('Error cargando métricas:', e);
    }
  }

  // 3. Cargar Lista de Postulantes
  async function loadCandidates() {
    try {
      const posVal = filterPosition.value;
      const statusVal = filterStatus.value;
      const params = new URLSearchParams();
      if (posVal) params.append('position_id', posVal);
      if (statusVal) params.append('status', statusVal);

      const res = await fetch(`/api/admin/candidates?${params.toString()}`);
      const candidates = await res.json();

      if (!Array.isArray(candidates) || candidates.length === 0) {
        candidatesTbody.innerHTML = `<tr><td colspan="9" class="loading-td">No hay postulaciones registradas.</td></tr>`;
        return;
      }

      candidatesTbody.innerHTML = candidates.map(c => {
        const scorePercent = c.total_questions > 0 ? Math.round((c.score / c.total_questions) * 100) : 0;
        
        return `
          <tr>
            <td><strong style="color: var(--accent);">#${c.id}</strong></td>
            <td><strong style="color: #fff;">${escapeHtml(c.full_name)}</strong></td>
            <td><span style="font-family: monospace; color: var(--text-muted);">${escapeHtml(c.rut_id)}</span></td>
            <td>${c.age} años</td>
            <td><span class="position-tag">${escapeHtml(c.position_name)}</span></td>
            <td>
              <span class="badge-code">${c.score}/${c.total_questions} (${scorePercent}%)</span>
            </td>
            <td>
              <span class="media-indicator">${c.audio_file ? '🎙️ Audio' : 'Sin Audio'}</span>
              <span class="media-separator">|</span>
              <span class="media-indicator">${c.initial_selfie ? '📸 Selfie' : 'Sin Foto'}</span>
            </td>
            <td>
              <span class="status-pill status-${c.status}">${c.status}</span>
            </td>
            <td>
              <button class="btn btn-secondary btn-sm" onclick="viewCandidate(${c.id})">
                🔍 Auditar
              </button>
            </td>
          </tr>
        `;
      }).join('');

      // Guardar lista local para modal
      window.currentCandidates = candidates;
    } catch (e) {
      candidatesTbody.innerHTML = `<tr><td colspan="9" class="loading-td">Error conectando con la base de datos</td></tr>`;
    }
  }

  // Abrir Modal de Auditoría
  window.viewCandidate = (id) => {
    const candidate = window.currentCandidates.find(c => c.id === id);
    if (!candidate) return;

    modalTitle.textContent = `Auditoría Candidato #${candidate.id}: ${candidate.full_name}`;

    const scorePercent = candidate.total_questions > 0 ? Math.round((candidate.score / candidate.total_questions) * 100) : 0;

    modalBody.innerHTML = `
      <div class="info-grid">
        <div class="info-item">
          <span class="label">RUT</span>
          <span class="value">${escapeHtml(candidate.rut_id)}</span>
        </div>
        <div class="info-item">
          <span class="label">Edad</span>
          <span class="value">${candidate.age} años (Cumple >25)</span>
        </div>
        <div class="info-item">
          <span class="label">Cargo</span>
          <span class="value">${escapeHtml(candidate.position_name)}</span>
        </div>
        <div class="info-item">
          <span class="label">Aciertos Técnicos</span>
          <span class="value">${candidate.score} / ${candidate.total_questions} (${scorePercent}%)</span>
        </div>
      </div>

      <!-- Verificación Biometría Anti-Trampa -->
      <div class="media-box">
        <h3>🔍 Verificación Biométrica Anti-Trampa</h3>
        <p style="font-size:0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">
          Compare la Selfie Inicial del candidato contra la captura fotográfica silenciosa tomada durante la prueba.
        </p>
        <div class="media-comparison-grid">
          <div>
            <strong style="font-size: 0.85rem;">Selfie Inicial Identidad:</strong>
            ${candidate.initial_selfie 
              ? `<img src="${candidate.initial_selfie}" alt="Selfie Inicial">` 
              : '<p class="loading-td">Sin foto inicial</p>'}
          </div>
          <div>
            <strong style="font-size: 0.85rem;">Captura Silenciosa (Durante Examen):</strong>
            ${candidate.random_selfie 
              ? `<img src="${candidate.random_selfie}" alt="Captura Aleatoria">` 
              : '<p class="loading-td">Sin captura silenciosa</p>'}
          </div>
        </div>
      </div>

      <!-- Grabación de Voz Situacional -->
      <div class="media-box">
        <h3>🎙️ Evaluación Oral & Comprensión de Instrucciones</h3>
        <p style="font-size:0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">
          Respuesta grabada en voz explicando el procedimiento técnico de minería.
        </p>
        ${candidate.audio_file 
          ? `<audio controls src="${candidate.audio_file}" style="width:100%;"></audio>` 
          : '<p class="loading-td">No grabó audio</p>'}
      </div>

      <!-- Documentos Adjuntos -->
      <div class="media-box">
        <h3>📜 Documentos Adjuntos</h3>
        <div style="display:flex; gap:1rem; justify-content:center; margin-top:0.5rem;">
          ${candidate.cert_file ? `<a href="${candidate.cert_file}" target="_blank" class="btn btn-secondary">📜 Ver Certificado</a>` : ''}
          ${candidate.antecedentes_file ? `<a href="${candidate.antecedentes_file}" target="_blank" class="btn btn-secondary">🛡️ Ver Antecedentes</a>` : ''}
        </div>
      </div>

      <!-- Acciones de Estado -->
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:1rem; padding-top:1rem; border-top: 1px solid var(--card-border);">
        <div>
          <span>Estado Actual: </span>
          <span class="status-pill status-${candidate.status}">${candidate.status}</span>
        </div>
        <div style="display:flex; gap:0.75rem;">
          <button class="btn btn-danger" onclick="updateCandidateStatus(${candidate.id}, 'Rechazado')">❌ Rechazar Candidato</button>
          <button class="btn btn-success" onclick="updateCandidateStatus(${candidate.id}, 'Aprobado')">✔ Aprobar para Entrevista</button>
        </div>
      </div>
    `;

    modalCandidate.style.display = 'flex';
  };

  // Actualizar Estado en MySQL
  window.updateCandidateStatus = async (id, status) => {
    try {
      const res = await fetch(`/api/admin/candidates/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });

      if (res.ok) {
        modalCandidate.style.display = 'none';
        loadCandidates();
        loadStats();
      } else {
        alert('Error actualizando el estado.');
      }
    } catch (e) {
      alert('Error de conexión.');
    }
  };

  btnCloseModal.addEventListener('click', () => {
    modalCandidate.style.display = 'none';
  });

  filterPosition.addEventListener('change', loadCandidates);
  filterStatus.addEventListener('change', loadCandidates);
  btnRefresh.addEventListener('click', () => {
    loadCandidates();
    loadStats();
  });

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m];
    });
  }

  loadPositions();
  loadStats();
  loadCandidates();
});
