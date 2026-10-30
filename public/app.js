document.addEventListener('DOMContentLoaded', () => {
  const state = {
    step: 1,
    positions: [],
    selectedPosition: null,
    candidateId: null,
    candidateData: {},
    credencialBase64: null,
    cvBase64: null,
    phase1OcrData: null,
    isRunningOcr: false,
    initialSelfieBase64: null,
    carnetFrontBase64: null,
    carnetBackBase64: null,
    antecedentesBase64: null,
    questions: [],
    currentQuestionIndex: 0,
    answers: [],
    timerInterval: null,
    timeLeft: 40,
    mediaStream: null
  };

  // Pasos del Wizard
  const wizardSteps = [
    document.getElementById('wizard-step-1'),
    document.getElementById('wizard-step-2'),
    document.getElementById('wizard-step-3'),
    document.getElementById('wizard-step-4')
  ];
  const navItems = [
    document.getElementById('step-nav-1'),
    document.getElementById('step-nav-2'),
    document.getElementById('step-nav-3')
  ];

  // DOM Fase 1
  const positionSelect = document.getElementById('position_id');
  const ecfRequirementHint = document.getElementById('ecf-requirement-hint');
  const labelCredencial = document.getElementById('label-credencial');
  const fileCredencial = document.getElementById('file-credencial');
  const credencialStatus = document.getElementById('credencial-status');
  const fileCv = document.getElementById('file-cv');
  const cvStatus = document.getElementById('cv-status');

  const ocrLiveBanner = document.getElementById('ocr-live-banner');
  const ocrLiveIcon = document.getElementById('ocr-live-icon');
  const ocrLiveText = document.getElementById('ocr-live-text');
  const ocrFieldsContainer = document.getElementById('ocr-fields-container');
  const ocrBadgeIndicator = document.getElementById('ocr-badge-indicator');

  const fullNameInput = document.getElementById('full_name');
  const rutInput = document.getElementById('rut_id');
  const emailInput = document.getElementById('email');
  const phoneInput = document.getElementById('phone');
  const cityInput = document.getElementById('city');
  const expInput = document.getElementById('experience_years');

  const hintName = document.getElementById('hint-name');
  const hintRut = document.getElementById('hint-rut');
  const hintEmail = document.getElementById('hint-email');
  const hintPhone = document.getElementById('hint-phone');
  const hintCity = document.getElementById('hint-city');
  const hintExp = document.getElementById('hint-exp');

  // Telemetría en Tiempo Real de Datos Parseados (Fase 1)
  const telemetryRut = document.getElementById('telemetry-rut');
  const telemetryCity = document.getElementById('telemetry-city');
  const telemetryExp = document.getElementById('telemetry-exp');
  const telemetryCred = document.getElementById('telemetry-cred');

  // Cámara Proctoring Transparente
  const webcamView = document.getElementById('webcam-view');
  const proctoringLiveVideo = document.getElementById('proctoring-live-video');
  const photoCanvas = document.getElementById('photo-canvas');
  const selfiePreview = document.getElementById('selfie-preview');
  const btnStartCamera = document.getElementById('btn-start-camera');
  const btnTakeSelfie = document.getElementById('btn-take-selfie');
  const consentProctoring = document.getElementById('consent-proctoring');
  const formStep1 = document.getElementById('form-step-1');

  // DOM Fase 1.5 (Mini-Test)
  const qCurrent = document.getElementById('q-current');
  const qTotal = document.getElementById('q-total');
  const questionText = document.getElementById('question-text');
  const optionsContainer = document.getElementById('options-container');
  const quizTimer = document.getElementById('quiz-timer');
  const btnNextQuestion = document.getElementById('btn-next-question');

  // DOM Fase 2 (Pre-Acreditación)
  const phase1ScoreBadge = document.getElementById('phase1-score-badge');
  const formPhase2 = document.getElementById('form-phase2');
  const fileCarnetFront = document.getElementById('file-carnet-front');
  const carnetFrontStatus = document.getElementById('carnet-front-status');
  const fileCarnetBack = document.getElementById('file-carnet-back');
  const carnetBackStatus = document.getElementById('carnet-back-status');
  const fileAntecedentes = document.getElementById('file-antecedentes');
  const antecedentesStatus = document.getElementById('antecedentes-status');
  const consentLey19628 = document.getElementById('consent-ley19628');
  const btnSubmitPhase2 = document.getElementById('btn-submit-phase2');

  // DOM Resultado Final
  const finalIcon = document.getElementById('final-icon');
  const finalTitle = document.getElementById('final-title');
  const finalSubtitle = document.getElementById('final-subtitle');
  const resultSummary = document.getElementById('result-summary');

  function formatTitleCase(str) {
    if (!str) return '';
    return str
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1) : '')
      .join(' ');
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = err => reject(err);
      reader.readAsDataURL(file);
    });
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  // Controlador de Dropzone Industrial (Drag & Drop + Validación Técnica)
  function setupIndustrialDropzone({
    dropzoneId,
    inputId,
    onFileSelected,
    onFileCleared,
    maxSizeMB = 10
  }) {
    const dropzone = document.getElementById(dropzoneId);
    const input = document.getElementById(inputId);
    if (!dropzone || !input) return;

    const emptyView = dropzone.querySelector('.dropzone-empty');
    const loadedView = dropzone.querySelector('.dropzone-loaded');
    const errorMsg = dropzone.querySelector('.dropzone-error-msg');
    const fileNameEl = dropzone.querySelector('.dropzone-file-name');
    const fileMetaEl = dropzone.querySelector('.dropzone-file-meta');
    const btnReplace = dropzone.querySelector('.btn-replace');
    const btnRemove = dropzone.querySelector('.btn-remove');

    function showError(msg) {
      dropzone.classList.add('dropzone-error');
      if (errorMsg) {
        errorMsg.textContent = msg;
        errorMsg.style.display = 'block';
      }
    }

    function clearError() {
      dropzone.classList.remove('dropzone-error');
      if (errorMsg) {
        errorMsg.textContent = '';
        errorMsg.style.display = 'none';
      }
    }

    function resetToEmpty() {
      clearError();
      input.value = '';
      dropzone.classList.remove('is-loaded');
      if (emptyView) emptyView.style.display = 'flex';
      if (loadedView) loadedView.style.display = 'none';
      if (fileNameEl) fileNameEl.textContent = '';
      if (fileMetaEl) fileMetaEl.textContent = '';
      if (onFileCleared) onFileCleared();
    }

    function setLoadedFile(file) {
      clearError();
      dropzone.classList.add('is-loaded');
      if (emptyView) emptyView.style.display = 'none';
      if (loadedView) loadedView.style.display = 'flex';
      if (fileNameEl) fileNameEl.textContent = file.name;
      if (fileMetaEl) fileMetaEl.textContent = `${formatFileSize(file.size)} - [VALIDADO TÉCNICAMENTE]`;
      if (onFileSelected) onFileSelected(file);
    }

    function validateAndProcess(file) {
      if (!file) return;

      const validExtensions = /\.(pdf|jpe?g|png|webp|bmp|docx?)$/i;
      const isWordMime = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || file.type === 'application/msword';
      const isMimeValid = file.type === 'application/pdf' || file.type.startsWith('image/') || isWordMime;
      const isExtValid = validExtensions.test(file.name);

      if (!isMimeValid && !isExtValid) {
        resetToEmpty();
        showError('[ERROR DE FORMATO]: Solo se admiten archivos PDF, DOCX, JPG o PNG');
        return;
      }

      const maxBytes = maxSizeMB * 1024 * 1024;
      if (file.size > maxBytes) {
        resetToEmpty();
        showError(`[ERROR DE TAMAÑO]: Excede el límite de ${maxSizeMB}MB (${formatFileSize(file.size)})`);
        return;
      }

      setLoadedFile(file);
    }

    // Clic en la caja abre selector si no está cargada
    dropzone.addEventListener('click', (e) => {
      if (e.target.closest('.btn-dropzone-action')) return;
      if (dropzone.classList.contains('is-loaded')) return;
      input.click();
    });

    if (btnReplace) {
      btnReplace.addEventListener('click', (e) => {
        e.stopPropagation();
        input.click();
      });
    }

    if (btnRemove) {
      btnRemove.addEventListener('click', (e) => {
        e.stopPropagation();
        resetToEmpty();
      });
    }

    input.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        validateAndProcess(file);
      }
    });

    // Eventos Drag & Drop con contador para evitar parpadeo en hijos
    let dragCounter = 0;
    dropzone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      dropzone.classList.add('drag-over');
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dropzone.classList.contains('drag-over')) {
        dropzone.classList.add('drag-over');
      }
    });

    dropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropzone.classList.remove('drag-over');
      }
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      dropzone.classList.remove('drag-over');

      const dt = e.dataTransfer;
      const file = dt && dt.files && dt.files[0];
      if (file) {
        try {
          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);
          input.files = dataTransfer.files;
        } catch (err) {
          // Fallback silencioso si DataTransfer no está soportado
        }
        validateAndProcess(file);
      }
    });
  }

  // 1. Cargar Cargos y Requisitos ECF Codelco
  async function loadPositions() {
    try {
      const res = await fetch('/api/positions');
      const data = await res.json();
      state.positions = data;
      positionSelect.innerHTML = '<option value="">Seleccione especialidad / cargo a postular...</option>' +
        data.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    } catch (err) {
      positionSelect.innerHTML = '<option value="">Error cargando cargos</option>';
    }
  }

  positionSelect.addEventListener('change', () => {
    const posId = parseInt(positionSelect.value, 10);
    const pos = state.positions.find(p => p.id === posId);
    state.selectedPosition = pos || null;

    if (pos) {
      const minExp = pos.min_experience_years || 2;
      const credName = pos.required_credential || 'Certificación Técnica Habilitante';
      const ecfCode = pos.ecf_code || 'ECF Codelco / DS N° 132';
      ecfRequirementHint.innerHTML = `<strong>${ecfCode}:</strong> Exige mínimo <strong>${minExp} años de experiencia</strong> y adjuntar <strong>${credName}</strong>.`;
      ecfRequirementHint.style.color = 'var(--primary)';
      labelCredencial.textContent = `${credName} *`;
      hintExp.textContent = `Mínimo exigido para este cargo: ${minExp} años de experiencia comprobable.`;
    }
  });

  // 2. Ejecutar OCR en Fase 1 (Credencial Técnica + CV)
  async function triggerPhase1OCR() {
    if (!state.credencialBase64 && !state.cvBase64) return;

    if (state.isRunningOcr) {
      state.pendingOcrRerun = true;
      return;
    }

    state.isRunningOcr = true;
    state.pendingOcrRerun = false;
    ocrLiveBanner.style.display = 'flex';
    ocrLiveBanner.className = 'ocr-banner ocr-banner-loading';
    ocrLiveIcon.textContent = '[PROCESANDO]';
    ocrLiveText.textContent = 'Extrayendo datos de su Credencial Técnica y/o CV mediante OCR local...';
    ocrFieldsContainer.style.display = 'block';

    try {
      const res = await fetch('/api/ocr/phase1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credencial_file: state.credencialBase64,
          cv_file: state.cvBase64
        })
      });

      const data = await res.json();
      if (res.ok) {
        state.phase1OcrData = data;

        if (data.full_name && !fullNameInput.dataset.edited) {
          fullNameInput.value = formatTitleCase(data.full_name);
          if (data.rut_source === 'CREDENCIAL') {
            hintName.textContent = 'Nombre legal oficial rescatado desde Licencia / Credencial Técnica';
          } else {
            hintName.textContent = 'Nombre extraído automáticamente por OCR';
          }
          hintName.style.color = 'var(--status-normal-text)';
        }

        if (data.rut_id && !rutInput.dataset.edited) {
          rutInput.value = data.rut_id;
          if (data.rut_discrepancia) {
            hintRut.textContent = `[DISCREPANCIA: RUT en CV (${data.rut_cv || 'S/I'}) difiere de Licencia/Credencial (${data.rut_credencial || 'S/I'})]`;
            hintRut.style.color = 'var(--safety-yellow)';
          } else if (data.rut_source === 'CREDENCIAL') {
            hintRut.textContent = 'RUT rescatado automáticamente de Licencia / Credencial Técnica Habilitante';
            hintRut.style.color = 'var(--status-normal-text)';
          } else if (data.rut_source === 'AMBOS_COINCIDENTES') {
            hintRut.textContent = 'RUT validado y coincidente en CV y Licencia/Credencial Técnica';
            hintRut.style.color = 'var(--status-normal-text)';
          } else {
            hintRut.textContent = 'RUT extraído desde Currículum Vitae (Se contrastará en Fase 2)';
            hintRut.style.color = 'var(--status-normal-text)';
          }
        }

        if (data.email && !emailInput.dataset.edited) {
          emailInput.value = data.email;
          hintEmail.textContent = 'Correo detectado automáticamente en CV';
          hintEmail.style.color = 'var(--status-normal-text)';
        }
        if (data.phone && !phoneInput.dataset.edited) {
          phoneInput.value = data.phone;
          hintPhone.textContent = 'Teléfono detectado automáticamente en CV';
          hintPhone.style.color = 'var(--status-normal-text)';
        }
        if (cityInput && !cityInput.dataset.edited) {
          if (data.city) {
            cityInput.value = data.city;
            if (hintCity) {
              hintCity.textContent = 'Ciudad de residencia detectada en encabezado/contacto del CV';
              hintCity.style.color = 'var(--status-normal-text)';
            }
          } else {
            cityInput.value = '';
            if (hintCity) {
              hintCity.textContent = 'CV sin ciudad de residencia explícita (ingrésela manualmente)';
              hintCity.style.color = 'var(--text-muted)';
            }
          }
        }
        if (data.experience_years !== null && data.experience_years !== undefined && !expInput.dataset.edited) {
          expInput.value = data.experience_years;
          if (data.experience_months !== null && data.experience_months !== undefined) {
            hintExp.textContent = `Experiencia calculada en sección laboral: ${data.experience_years} años (${data.experience_months} meses efectivos, sin prácticas)`;
          } else {
            hintExp.textContent = `Experiencia calculada por OCR desde CV: ${data.experience_years} años`;
          }
          hintExp.style.color = 'var(--status-normal-text)';
        }

        // Actualizar Telemetría en Tiempo Real
        if (telemetryRut) {
          if (data.rut_id) {
            const srcLabel = data.rut_source === 'CREDENCIAL' ? 'LICENCIA' : (data.rut_source === 'AMBOS_COINCIDENTES' ? 'VERIFICADO 2x' : (data.rut_source === 'DISCREPANCIA' ? 'DISCREPANCIA' : 'CV'));
            telemetryRut.textContent = `${data.rut_id} [${srcLabel}]`;
          } else {
            telemetryRut.textContent = 'NO DETECTADO (INGRESO MANUAL)';
          }
        }
        if (telemetryCity) telemetryCity.textContent = data.city || 'NO ESPECIFICADA EN CV';
        if (telemetryExp) {
          const m = data.experience_months !== null && data.experience_months !== undefined ? data.experience_months : 0;
          telemetryExp.textContent = `${data.experience_years || 0} AÑOS (${m} MESES EFECTIVOS)`;
        }
        if (telemetryCred) {
          telemetryCred.textContent = `${data.credencial_status || 'VERIFICADA'} (${data.credencial_vigencia || 'VIGENTE'})`;
        }

        const engineLabel = (data.ocr_engine && data.ocr_engine.includes('GEMINI')) ? '[MOTOR: GEMINI FLASH]' : '[MOTOR: LOCAL TESSERACT]';
        if (data.rut_discrepancia) {
          ocrLiveBanner.className = 'ocr-banner ocr-banner-warn';
          ocrLiveIcon.textContent = '[ATENCIÓN]';
          ocrLiveText.textContent = `${engineLabel} Alerta: El RUT del CV (${data.rut_cv}) difiere de la Licencia/Credencial (${data.rut_credencial}). Se priorizó la Licencia Oficial. Verifique sus datos abajo.`;
        } else {
          ocrLiveBanner.className = 'ocr-banner ocr-banner-done';
          ocrLiveIcon.textContent = '[OCR OK]';
          const srcMsg = data.rut_source === 'CREDENCIAL' ? ' (RUT rescatado desde Licencia/Credencial)' : '';
          ocrLiveText.textContent = `${engineLabel} OCR Fase 1 completado (${data.credencial_status || 'Documento procesado'} — ${data.credencial_vigencia || 'Vigente'})${srcMsg}. Verifique sus datos abajo o edite cualquier campo si es necesario.`;
        }
      } else {
        ocrLiveBanner.className = 'ocr-banner ocr-banner-warn';
        ocrLiveIcon.textContent = '[AVISO]';
        ocrLiveText.textContent = 'Complete o verifique manualmente sus datos en el formulario inferior.';
      }
    } catch (e) {
      ocrLiveBanner.className = 'ocr-banner ocr-banner-warn';
      ocrLiveIcon.textContent = '[AVISO]';
      ocrLiveText.textContent = 'No se pudo conectar al motor OCR. Puede completar o corregir sus datos manualmente abajo.';
    } finally {
      state.isRunningOcr = false;
      if (state.pendingOcrRerun) {
        state.pendingOcrRerun = false;
        await triggerPhase1OCR();
      }
    }
  }

  // Fase 1: Credencial Técnica
  setupIndustrialDropzone({
    dropzoneId: 'dropzone-credencial',
    inputId: 'file-credencial',
    onFileSelected: async (file) => {
      state.credencialBase64 = await fileToBase64(file);
      credencialStatus.textContent = `Credencial cargada: ${file.name}`;
      credencialStatus.style.color = 'var(--ecf-emerald)';
      await triggerPhase1OCR();
    },
    onFileCleared: () => {
      state.credencialBase64 = null;
      credencialStatus.textContent = '[ESCANEO ACTIVO: Carnet Rigger, WPQ o Licencia D]';
      credencialStatus.style.color = '';
    }
  });

  // Fase 1: Currículum Vitae (CV)
  setupIndustrialDropzone({
    dropzoneId: 'dropzone-cv',
    inputId: 'file-cv',
    onFileSelected: async (file) => {
      state.cvBase64 = await fileToBase64(file);
      cvStatus.textContent = `CV cargado: ${file.name}`;
      cvStatus.style.color = 'var(--ecf-emerald)';
      await triggerPhase1OCR();
    },
    onFileCleared: () => {
      state.cvBase64 = null;
      cvStatus.textContent = '[ESCANEO ACTIVO: CV en PDF, DOCX o Imagen (Contacto y Fechas)]';
      cvStatus.style.color = '';
    }
  });

  // Marcar edición manual por el candidato y actualizar telemetría
  function bindManualEdit(inputEl, hintEl, label) {
    if (!inputEl) return;
    inputEl.addEventListener('input', () => {
      inputEl.dataset.edited = 'true';
      ocrBadgeIndicator.textContent = 'Verificado / Editado por Postulante';
      ocrBadgeIndicator.className = 'status-pill status-Pendiente';
      if (hintEl) {
        hintEl.textContent = `${label} editado/confirmado manualmente`;
        hintEl.style.color = 'var(--secondary)';
      }
      if (inputEl === rutInput && telemetryRut) {
        telemetryRut.textContent = rutInput.value.trim() || 'NO DETECTADO';
      }
      if (inputEl === cityInput && telemetryCity) {
        telemetryCity.textContent = cityInput.value.trim() || 'NO ESPECIFICADA';
      }
      if (inputEl === expInput && telemetryExp) {
        telemetryExp.textContent = `${expInput.value || 0} AÑOS (MANUAL)`;
      }
    });
  }

  bindManualEdit(fullNameInput, hintName, 'Nombre');
  bindManualEdit(rutInput, hintRut, 'RUT');
  bindManualEdit(emailInput, hintEmail, 'Correo');
  bindManualEdit(phoneInput, hintPhone, 'Teléfono');
  bindManualEdit(cityInput, hintCity, 'Ciudad');
  bindManualEdit(expInput, hintExp, 'Experiencia');

  if (fullNameInput) {
    fullNameInput.addEventListener('blur', () => {
      fullNameInput.value = formatTitleCase(fullNameInput.value);
    });
  }

  // 3. Cámara para Proctoring Transparente (Visible en todo momento)
  btnStartCamera.addEventListener('click', async () => {
    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      webcamView.srcObject = state.mediaStream;
      if (proctoringLiveVideo) {
        proctoringLiveVideo.srcObject = state.mediaStream;
      }
      btnTakeSelfie.disabled = false;
      btnStartCamera.textContent = 'Cámara Visible Activa';
      btnStartCamera.disabled = true;
    } catch (err) {
      alert('No se pudo acceder a la cámara web. Asegúrese de otorgar permisos en el navegador.');
    }
  });

  btnTakeSelfie.addEventListener('click', () => {
    if (!state.mediaStream) return;
    const context = photoCanvas.getContext('2d');
    photoCanvas.width = webcamView.videoWidth || 640;
    photoCanvas.height = webcamView.videoHeight || 480;
    context.drawImage(webcamView, 0, 0, photoCanvas.width, photoCanvas.height);

    state.initialSelfieBase64 = photoCanvas.toDataURL('image/jpeg');
    selfiePreview.src = state.initialSelfieBase64;
    selfiePreview.style.display = 'block';
    webcamView.style.display = 'none';
    btnTakeSelfie.textContent = 'Selfie de Validación Capturada';
    btnTakeSelfie.classList.replace('btn-camera', 'btn-success');
  });

  function goToStep(stepNum) {
    state.step = stepNum;
    wizardSteps.forEach((s, idx) => {
      s.style.display = (idx + 1 === stepNum) ? 'block' : 'none';
    });

    navItems.forEach((n, idx) => {
      if (idx + 1 === stepNum) {
        n.classList.add('active');
      } else if (idx + 1 < stepNum) {
        n.classList.remove('active');
        n.classList.add('completed');
      } else {
        n.classList.remove('active', 'completed');
      }
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 4. Fase 1 Submit -> Iniciar Fase 1.5 (Mini-Test Técnico de 5 preguntas)
  formStep1.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (state.isRunningOcr) {
      alert('Espere unos segundos a que finalice la lectura OCR de sus documentos.');
      return;
    }

    if (!state.credencialBase64 || !state.cvBase64) {
      alert('Debe adjuntar su Credencial Técnica Habilitante y su Currículum Vitae (CV).');
      return;
    }

    if (!state.initialSelfieBase64) {
      alert('Por favor active su cámara y tome la Selfie de Validación Informada antes de iniciar el Mini-Test.');
      return;
    }

    if (!consentProctoring.checked) {
      alert('Debe aceptar el Consentimiento de Proctoring Transparente para rendir el Mini-Test Técnico.');
      return;
    }

    const formattedName = formatTitleCase(fullNameInput.value);
    fullNameInput.value = formattedName;

    state.candidateData = {
      full_name: formattedName,
      rut_id: rutInput.value.trim(),
      email: emailInput.value.trim(),
      phone: phoneInput.value.trim(),
      city: cityInput.value.trim(),
      experience_years: parseInt(expInput.value || '0', 10),
      position_id: parseInt(positionSelect.value, 10)
    };

    try {
      const res = await fetch(`/api/positions/${state.candidateData.position_id}/questions`);
      const data = await res.json();
      state.questions = data.questions || [];

      if (state.questions.length === 0) {
        alert('No hay preguntas configuradas para esta especialidad.');
        return;
      }

      goToStep(2);
      startMiniTest();
    } catch (err) {
      alert('Error cargando el Mini-Test Técnico.');
    }
  });

  // 5. Lógica del Mini-Test Técnico (Fase 1.5)
  function startMiniTest() {
    state.currentQuestionIndex = 0;
    state.answers = [];
    qTotal.textContent = state.questions.length;
    showQuestion(0);
  }

  function showQuestion(index) {
    if (index >= state.questions.length) {
      clearInterval(state.timerInterval);
      submitPhase1AndEvaluate();
      return;
    }

    const q = state.questions[index];
    qCurrent.textContent = index + 1;
    questionText.textContent = q.question_text;

    const isSjt = q.category === 'SJT';
    const catHtml = isSjt
      ? `<span class="mining-tag" style="background: rgba(255, 184, 0, 0.15); color: var(--safety-yellow); border-color: var(--safety-yellow); margin-bottom: 0.5rem; display: inline-block;">[CASO SJT: SEGURIDAD CRÍTICA / ECF CODELCO]</span><br>`
      : `<span class="mining-tag" style="color: var(--text-secondary); margin-bottom: 0.5rem; display: inline-block;">[IDONEIDAD TÉCNICA ESPECÍFICA]</span><br>`;

    const progressEl = document.querySelector('.question-progress');
    if (progressEl) {
      progressEl.innerHTML = `${catHtml}Pregunta ${index + 1} de ${state.questions.length}`;
    }

    optionsContainer.innerHTML = [
      { key: 'A', text: q.option_a },
      { key: 'B', text: q.option_b },
      { key: 'C', text: q.option_c },
      { key: 'D', text: q.option_d }
    ].map(opt => `
      <button type="button" class="option-btn" data-key="${opt.key}">
        <strong>${opt.key})</strong> ${opt.text}
      </button>
    `).join('');

    let selectedOption = null;
    document.querySelectorAll('.option-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.option-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedOption = btn.dataset.key;
      });
    });

    clearInterval(state.timerInterval);
    state.timeLeft = 40;
    quizTimer.textContent = `${state.timeLeft}s`;

    state.timerInterval = setInterval(() => {
      state.timeLeft--;
      quizTimer.textContent = `${state.timeLeft}s`;
      if (state.timeLeft <= 0) {
        clearInterval(state.timerInterval);
        recordAnswerAndAdvance(selectedOption || 'N/A');
      }
    }, 1000);

    btnNextQuestion.onclick = () => {
      clearInterval(state.timerInterval);
      recordAnswerAndAdvance(selectedOption || 'N/A');
    };
  }

  function recordAnswerAndAdvance(selectedOption) {
    const q = state.questions[state.currentQuestionIndex];
    state.answers.push({
      question_id: q.id,
      selected_option: selectedOption
    });
    state.currentQuestionIndex++;
    showQuestion(state.currentQuestionIndex);
  }

  // 6. Evaluar Fase 1 + 1.5 y decidir si desbloquea Fase 2 (Pre-Acreditación) o Descarta Técnicamente
  async function submitPhase1AndEvaluate() {
    btnNextQuestion.disabled = true;
    btnNextQuestion.textContent = 'Evaluando Filtro Técnico ECF...';

    // Detener stream de cámara tras finalizar el Mini-Test
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(t => t.stop());
    }

    try {
      const res = await fetch('/api/candidates/phase1-submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...state.candidateData,
          cv_file: state.cvBase64,
          credencial_file: state.credencialBase64,
          initial_selfie: state.initialSelfieBase64,
          consent_proctoring: true,
          answers: state.answers,
          phase1_ocr_data: state.phase1OcrData
        })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(`Error al evaluar Fase 1: ${data.error}`);
        return;
      }

      state.candidateId = data.candidateId;

      if (data.status === 'PRESELECCIONADO') {
        // PRESELECCIONADO: Evaluación técnica aprobada, en espera de aprobación de cupo por RR.HH.
        finalIcon.textContent = 'ESTADO: PRESELECCIONADO TÉCNICAMENTE';
        finalIcon.className = 'status-pill status-Aprobado';
        finalTitle.textContent = 'Evaluación Técnica Aprobada — En Espera de Cupo para Faena';
        finalSubtitle.textContent = 'Su postulación ha sido calificada conforme y se encuentra en revisión por el equipo de RR.HH. de Nexxo S.A. para asignación de cupo en División El Teniente.';
        
        resultSummary.innerHTML = `
          <div class="info-grid">
            <div class="info-item">
              <span class="label">Folio Postulación</span>
              <span class="value">#${data.candidateId}</span>
            </div>
            <div class="info-item">
              <span class="label">Score Técnico</span>
              <span class="value">[${data.score_tecnico}/3]</span>
            </div>
            <div class="info-item">
              <span class="label">Índice Conductual ECF</span>
              <span class="value" style="color: var(--ecf-emerald); font-weight: 800;">
                [CONFORME (2/2)]
              </span>
            </div>
            <div class="info-item">
              <span class="label">Veredicto Técnico</span>
              <span class="status-pill status-Aprobado">[PRESELECCIONADO]</span>
            </div>
          </div>

          <div style="margin-top: 1.25rem; text-align: left; background: var(--surface-panel); border: 1px solid var(--safety-yellow); border-left: 4px solid var(--safety-yellow); color: var(--text-primary); padding: 1.25rem; border-radius: var(--radius-terminal); font-size: 0.88rem; font-family: 'JetBrains Mono', monospace;">
            <strong style="color: var(--safety-yellow);">ETAPA ACTUAL: ASIGNACIÓN DE DOTACIÓN POR RR.HH.</strong><br><br>
            Ha calificado técnicamente para la parada de planta en <strong>División El Teniente</strong>.<br><br>
            <strong>Próximos Pasos Normativos:</strong><br>
            1. El equipo de Reclutamiento y Acreditación de Nexxo S.A. validará los cupos de dotación disponibles.<br>
            2. Una vez <strong>aprobado su acceso a faena</strong>, recibirá automáticamente un <strong>enlace de acceso seguro (Magic Link)</strong> en su correo electrónico (<strong>${state.candidateData.email || 'declarado'}</strong>).<br>
            3. Mediante ese enlace exclusivo podrá ingresar a la <strong>Fase 02 (Validación Documental)</strong> para adjuntar su Cédula de Identidad y Certificado de Antecedentes (Vigencia &le; 60 días).<br><br>
            <em>En estricto cumplimiento de la Ley N° 19.628 y la normativa laboral de la Dirección del Trabajo, su documentación penal no es requerida hasta que cuente con aprobación formal de cupo de faena.</em>
          </div>
        `;
        goToStep(4);
      } else {
        // DESCARTADO_TECNICO: Mostrar feedback normativo inmediato sin pedir Carnet ni Antecedentes
        finalIcon.textContent = 'ESTADO: DESCARTADO TÉCNICO';
        finalIcon.className = 'status-pill status-Rechazado';
        finalTitle.textContent = 'Resultado Filtro Técnico: No Califica en esta Convocatoria';
        finalSubtitle.textContent = 'Su postulación no alcanzó el umbral técnico o de apego a normas de seguridad crítica exigido por los ECF de Codelco.';
        resultSummary.innerHTML = `
          <div class="info-grid">
            <div class="info-item">
              <span class="label">Folio Postulación</span>
              <span class="value">#${data.candidateId}</span>
            </div>
            <div class="info-item">
              <span class="label">Score Técnico</span>
              <span class="value">[${data.score_tecnico}/3]</span>
            </div>
            <div class="info-item">
              <span class="label">Índice Conductual ECF</span>
              <span class="value" style="color: ${data.sjt_conforme ? 'var(--ecf-emerald)' : 'var(--ecf-crimson)'}; font-weight: 800;">
                [${data.sjt_conforme ? 'CONFORME (2/2)' : 'NO CONFORME'}]
              </span>
            </div>
            <div class="info-item">
              <span class="label">Veredicto Final</span>
              <span class="status-pill status-Rechazado">[${data.status}]</span>
            </div>
          </div>
          <div style="margin-top: 1.25rem; text-align: left; background: var(--surface-panel); border: 1px solid var(--ecf-crimson-border); border-left: 4px solid var(--ecf-crimson); color: var(--text-primary); padding: 1rem; border-radius: var(--radius-terminal); font-size: 0.88rem; font-family: 'JetBrains Mono', monospace;">
            <strong style="color: var(--ecf-crimson);">DIAGNÓSTICO DEL DESCARTE AUTOMÁTICO:</strong><br>
            ${(data.rejectionReasons || []).map(r => `• ${r}`).join('<br>')}
          </div>
          <p style="margin-top: 1rem; color: var(--text-muted); font-size: 0.82rem; font-family: 'JetBrains Mono', monospace;">
            En estricto cumplimiento de la normativa laboral (Dirección del Trabajo y Ley N° 19.628), no se le ha solicitado Cédula de Identidad ni Certificado de Antecedentes Penales.
          </p>
        `;
        goToStep(4);
      }
    } catch (err) {
      alert('Error de conexión al evaluar el Mini-Test.');
    } finally {
      btnNextQuestion.disabled = false;
      btnNextQuestion.textContent = 'Confirmar Respuesta y Siguiente';
    }
  }

  // 7. Fase 2 & 3: Subida de Carnet + Antecedentes y Motor OCR de Validación Cruzada
  setupIndustrialDropzone({
    dropzoneId: 'dropzone-carnet-front',
    inputId: 'file-carnet-front',
    onFileSelected: async (file) => {
      state.carnetFrontBase64 = await fileToBase64(file);
      carnetFrontStatus.textContent = `Cédula Frente cargada: ${file.name}`;
      carnetFrontStatus.style.color = 'var(--ecf-emerald)';
    },
    onFileCleared: () => {
      state.carnetFrontBase64 = null;
      carnetFrontStatus.textContent = '[ESCANEO: Valida RUT, Nombre y Vigencia]';
      carnetFrontStatus.style.color = '';
    }
  });

  setupIndustrialDropzone({
    dropzoneId: 'dropzone-carnet-back',
    inputId: 'file-carnet-back',
    onFileSelected: async (file) => {
      state.carnetBackBase64 = await fileToBase64(file);
      carnetBackStatus.textContent = `Cédula Reverso cargada: ${file.name}`;
      carnetBackStatus.style.color = 'var(--ecf-emerald)';
    },
    onFileCleared: () => {
      state.carnetBackBase64 = null;
      carnetBackStatus.textContent = '[ESCANEO: Reverso del documento]';
      carnetBackStatus.style.color = '';
    }
  });

  setupIndustrialDropzone({
    dropzoneId: 'dropzone-antecedentes',
    inputId: 'file-antecedentes',
    onFileSelected: async (file) => {
      state.antecedentesBase64 = await fileToBase64(file);
      antecedentesStatus.textContent = `Cert. Antecedentes cargado: ${file.name}`;
      antecedentesStatus.style.color = 'var(--ecf-emerald)';
    },
    onFileCleared: () => {
      state.antecedentesBase64 = null;
      antecedentesStatus.textContent = '[REGISTRO CIVIL: Vigencia ≤ 60 días]';
      antecedentesStatus.style.color = '';
    }
  });

  formPhase2.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!state.carnetFrontBase64 || !state.antecedentesBase64) {
      alert('Por favor adjunte la foto de su Cédula de Identidad y su Certificado de Antecedentes.');
      return;
    }

    if (!consentLey19628.checked) {
      alert('Debe marcar la casilla de Consentimiento Expreso (Ley N° 19.628) para continuar.');
      return;
    }

    btnSubmitPhase2.disabled = true;
    btnSubmitPhase2.textContent = 'Ejecutando Motor OCR de Validación Cruzada (Fase 3)...';

    try {
      const res = await fetch(`/api/candidates/${state.candidateId}/phase2-acreditacion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carnet_file: state.carnetFrontBase64,
          carnet_back_file: state.carnetBackBase64,
          antecedentes_file: state.antecedentesBase64,
          consent_ley19628: true
        })
      });

      const data = await res.json();
      if (!res.ok) {
        alert(`Error en Pre-Acreditación: ${data.error}`);
        btnSubmitPhase2.disabled = false;
        btnSubmitPhase2.textContent = 'Ejecutar Validación Cruzada OCR y Finalizar Pre-Acreditación';
        return;
      }

      const isPreAcreditado = data.status === 'PRE_ACREDITADO';
      finalIcon.textContent = isPreAcreditado ? 'ESTADO: PRE-ACREDITADO' : 'ESTADO: EN REVISIÓN MANUAL';
      finalIcon.className = `status-pill ${isPreAcreditado ? 'status-Aprobado' : 'status-Pendiente'}`;
      finalTitle.textContent = isPreAcreditado
        ? 'Expediente 100% Pre-Acreditado para División El Teniente'
        : 'Documentación Recibida — En Revisión Manual por RR.HH.';
      finalSubtitle.textContent = isPreAcreditado
        ? 'El motor OCR validó exitosamente la consistencia entre su Cédula, Certificación Técnica y Antecedentes. Su Carpeta WebControl está lista.'
        : 'Sus documentos fueron cargados correctamente. Un especialista de Nexxo S.A. verificará visualmente un detalle de lectura OCR.';

      resultSummary.innerHTML = `
        <div class="info-grid">
          <div class="info-item">
            <span class="label">Folio Expediente</span>
            <span class="value">#${data.candidateId}</span>
          </div>
          <div class="info-item">
            <span class="label">Vigencia Cédula (OCR)</span>
            <span class="value">${data.ocrCarnetVigencia || 'En verificación'}</span>
          </div>
          <div class="info-item">
            <span class="label">Antecedentes (OCR)</span>
            <span class="value">${data.ocrAntecedentesStatus || 'Recibido'}</span>
          </div>
          <div class="info-item">
            <span class="label">Estado Máquina de Estados</span>
            <span class="status-pill ${isPreAcreditado ? 'status-Aprobado' : 'status-Pendiente'}">${data.status}</span>
          </div>
        </div>
        ${data.discrepancies && data.discrepancies.length > 0 ? `
          <div style="margin-top: 1.25rem; text-align: left; background: var(--status-warning-bg); border: 1px solid var(--status-warning-border); color: var(--status-warning-text); padding: 1rem; border-radius: var(--radius-standard); font-size: 0.88rem;">
            <strong>Detalle enviado a mesa de revisión de RR.HH. Nexxo:</strong><br>
            ${data.discrepancies.join('<br>')}
          </div>
        ` : `
          <div style="margin-top: 1.25rem; text-align: left; background: var(--status-normal-bg); border: 1px solid var(--status-normal-border); color: var(--status-normal-text); padding: 1rem; border-radius: var(--radius-standard); font-size: 0.88rem;">
            <strong>Cruce de Identidad 100% Consistente:</strong> El RUT y Nombre de su Cédula coinciden con su postulación y certificación técnica de la Fase 1.
          </div>
        `}
      `;

      goToStep(4);
    } catch (err) {
      alert('Error de conexión al procesar la Fase 2.');
      btnSubmitPhase2.disabled = false;
      btnSubmitPhase2.textContent = 'Ejecutar Validación Cruzada OCR y Finalizar Pre-Acreditación';
    }
  });

  async function checkAccessTokenAndResume() {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    if (!token) return;

    try {
      const res = await fetch(`/api/candidates/access/${encodeURIComponent(token)}`);
      const data = await res.json();
      if (!res.ok) {
        alert(`[ACCESO A FAENA NO AUTORIZADO]\n\n${data.error || 'El enlace no es válido o requiere aprobación de faena previa por parte de RR.HH.'}`);
        return;
      }

      state.candidateId = data.id;
      state.candidateData = data;

      // Actualizar encabezado de Fase 2
      phase1ScoreBadge.innerHTML = `
        Postulante: <strong>${data.full_name}</strong> | 
        RUT: <strong>${data.rut_id}</strong> | 
        Cargo: <strong>${data.position_name}</strong> | 
        Autorización: <strong style="color: var(--ecf-emerald);">[ACCESO A FAENA APROBADO]</strong>
      `;

      // Navegar a Fase 2 (Step 3)
      goToStep(3);

      // Desplegar aviso de sesión activa autorizada
      const bannerContainer = document.createElement('div');
      bannerContainer.className = 'ocr-banner ocr-banner-done';
      bannerContainer.style.marginBottom = '1.25rem';
      bannerContainer.innerHTML = `
        <strong style="font-family: 'JetBrains Mono', monospace;">[ACCESO A FAENA APROBADO]</strong>
        <span>Bienvenido/a <strong>${data.full_name}</strong>. Su cupo ha sido autorizado por RR.HH. Ingrese su Cédula y Certificado de Antecedentes para conformar su Carpeta WebControl Codelco.</span>
      `;

      const formPhase2El = document.getElementById('form-phase2');
      if (formPhase2El && formPhase2El.parentNode) {
        formPhase2El.parentNode.insertBefore(bannerContainer, formPhase2El);
      }
    } catch (e) {
      console.error('[Error verificando token de acceso]:', e);
    }
  }

  loadPositions();
  checkAccessTokenAndResume();
});
