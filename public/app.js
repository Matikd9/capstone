document.addEventListener("DOMContentLoaded", () => {
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
    randomCaptureQuestionIndex: null,
    randomSelfieCaptured: false,
    randomSelfieBase64: null,
    carnetFrontBase64: null,
    carnetBackBase64: null,
    antecedentesBase64: null,
    questions: [],
    currentQuestionIndex: 0,
    answers: [],
    timerInterval: null,
    timeLeft: 40,
    mediaStream: null,
  };

  // Pasos del Wizard
  const wizardSteps = [
    document.getElementById("wizard-step-1"),
    document.getElementById("wizard-step-2"),
    document.getElementById("wizard-step-3"),
    document.getElementById("wizard-step-4"),
  ];
  const navItems = [
    document.getElementById("step-nav-1"),
    document.getElementById("step-nav-2"),
    document.getElementById("step-nav-3"),
  ];

  // DOM Fase 1
  const positionSelect = document.getElementById("position_id");
  const ecfRequirementHint = document.getElementById("ecf-requirement-hint");
  const labelCredencial = document.getElementById("label-credencial");
  const fileCredencial = document.getElementById("file-credencial");
  const credencialStatus = document.getElementById("credencial-status");
  const fileCv = document.getElementById("file-cv");
  const cvStatus = document.getElementById("cv-status");

  const ocrLiveBanner = document.getElementById("ocr-live-banner");
  const ocrLiveIcon = document.getElementById("ocr-live-icon");
  const ocrLiveText = document.getElementById("ocr-live-text");
  const ocrFieldsContainer = document.getElementById("ocr-fields-container");
  const ocrBadgeIndicator = document.getElementById("ocr-badge-indicator");

  const fullNameInput = document.getElementById("full_name");
  const rutInput = document.getElementById("rut_id");
  const emailInput = document.getElementById("email");
  const phoneInput = document.getElementById("phone");
  const phonePrefixSelect = document.getElementById("phone-prefix");
  const cityInput = document.getElementById("city");
  const expInput = document.getElementById("experience_years");

  const hintName = document.getElementById("hint-name");
  const hintRut = document.getElementById("hint-rut");
  const hintEmail = document.getElementById("hint-email");
  const hintPhone = document.getElementById("hint-phone");
  const hintCity = document.getElementById("hint-city");
  const hintExp = document.getElementById("hint-exp");

  const btnUnlockManual = document.getElementById("btn-unlock-manual");
  const phoneGroup = document.getElementById("phone-group");
  const ocrAutofillDesc = document.getElementById("ocr-autofill-desc");

  const phase1Inputs = [
    fullNameInput,
    rutInput,
    emailInput,
    phoneInput,
    cityInput,
    expInput,
  ].filter(Boolean);

  function lockPhase1Inputs() {
    phase1Inputs.forEach((input) => {
      input.disabled = true;
    });
    if (phonePrefixSelect) phonePrefixSelect.disabled = true;
    if (phoneGroup) phoneGroup.classList.add("is-locked");
    if (ocrBadgeIndicator) {
      ocrBadgeIndicator.textContent = "ESPERANDO DOCUMENTOS";
      ocrBadgeIndicator.className = "status-pill status-Pendiente";
    }
  }

  function unlockPhase1Inputs(isManual = false, hasDiscrepancy = false) {
    phase1Inputs.forEach((input) => {
      input.disabled = false;
    });
    if (phonePrefixSelect) phonePrefixSelect.disabled = false;
    if (phoneGroup) phoneGroup.classList.remove("is-locked");
    if (ocrAutofillDesc) {
      if (isManual) {
        ocrAutofillDesc.textContent =
          "Campos habilitados para ingreso manual. Por favor complete y confirme sus datos personales.";
      } else if (hasDiscrepancy) {
        ocrAutofillDesc.textContent =
          "Se detectaron discrepancias entre los documentos adjuntos. Verifique y confirme sus datos personales.";
      } else {
        ocrAutofillDesc.textContent =
          "La información ha sido cargada a partir de sus documentos adjuntos. Por favor verifique y confirme sus datos personales.";
      }
    }
    if (ocrBadgeIndicator) {
      if (isManual) {
        ocrBadgeIndicator.textContent = "INGRESO MANUAL";
        ocrBadgeIndicator.className = "status-pill status-Pendiente";
      } else if (hasDiscrepancy) {
        ocrBadgeIndicator.textContent = "DISCREPANCIAS DETECTADAS";
        ocrBadgeIndicator.className = "status-pill status-Pendiente";
      } else {
        ocrBadgeIndicator.textContent = "DOCUMENTOS VALIDADOS";
        ocrBadgeIndicator.className = "status-pill status-Aprobado";
      }
    }
    if (btnUnlockManual) {
      btnUnlockManual.style.display = "none";
    }
  }

  if (btnUnlockManual) {
    btnUnlockManual.addEventListener("click", () => {
      unlockPhase1Inputs(true);
    });
  }

  // Iniciar campos bloqueados hasta que el OCR procese los documentos
  lockPhase1Inputs();

  // Telemetría en Tiempo Real de Datos Parseados (Fase 1)
  const telemetryRut = document.getElementById("telemetry-rut");
  const telemetryCity = document.getElementById("telemetry-city");
  const telemetryExp = document.getElementById("telemetry-exp");
  const telemetryCred = document.getElementById("telemetry-cred");

  // Cámara Proctoring Transparente
  const webcamView = document.getElementById("webcam-view");
  const proctoringLiveVideo = document.getElementById("proctoring-live-video");
  const photoCanvas = document.getElementById("photo-canvas");
  const selfiePreview = document.getElementById("selfie-preview");
  const btnStartCamera = document.getElementById("btn-start-camera");
  const btnTakeSelfie = document.getElementById("btn-take-selfie");
  const consentProctoring = document.getElementById("consent-proctoring");
  const formStep1 = document.getElementById("form-step-1");

  // DOM Fase 1.5 (Mini-Test)
  const qCurrent = document.getElementById("q-current");
  const qTotal = document.getElementById("q-total");
  const questionText = document.getElementById("question-text");
  const optionsContainer = document.getElementById("options-container");
  const quizTimer = document.getElementById("quiz-timer");
  const btnNextQuestion = document.getElementById("btn-next-question");

  // DOM Fase 2 (Pre-Acreditación)
  const phase1ScoreBadge = document.getElementById("phase1-score-badge");
  const formPhase2 = document.getElementById("form-phase2");
  const fileCarnetFront = document.getElementById("file-carnet-front");
  const carnetFrontStatus = document.getElementById("carnet-front-status");
  const fileCarnetBack = document.getElementById("file-carnet-back");
  const carnetBackStatus = document.getElementById("carnet-back-status");
  const fileAntecedentes = document.getElementById("file-antecedentes");
  const antecedentesStatus = document.getElementById("antecedentes-status");
  const consentLey19628 = document.getElementById("consent-ley19628");
  const btnSubmitPhase2 = document.getElementById("btn-submit-phase2");

  // DOM Resultado Final
  const finalIcon = document.getElementById("final-icon");
  const finalTitle = document.getElementById("final-title");
  const finalSubtitle = document.getElementById("final-subtitle");
  const resultSummary = document.getElementById("result-summary");

  function formatTitleCase(str) {
    if (!str) return "";
    return str
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : ""))
      .join(" ");
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Convierte un archivo a base64, comprimiendo automáticamente fotos de alta resolución
   * en Canvas para reducir la carga de red y acelerar el OCR de ~20s a ~3s.
   */
  async function fileToBase64(file, maxDimension = 1600, quality = 0.85) {
    if (!file) return null;

    // Si es PDF, DOCX u otro documento no imagen, devolver base64 directo
    if (!file.type || !file.type.startsWith("image/")) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (err) => reject(err);
        reader.readAsDataURL(file);
      });
    }

    // Para imágenes (fotos de celulares de alta resolución): redimensionar en Canvas
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }

          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);

          // Convertir a JPEG optimizado
          const optimizedDataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve(optimizedDataUrl);
        };
        img.onerror = () => {
          // Fallback a base64 original si falla el canvas
          resolve(e.target.result);
        };
        img.src = e.target.result;
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return "0 B";
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
    maxSizeMB = 10,
  }) {
    const dropzone = document.getElementById(dropzoneId);
    const input = document.getElementById(inputId);
    if (!dropzone || !input) return;

    const emptyView = dropzone.querySelector(".dropzone-empty");
    const loadedView = dropzone.querySelector(".dropzone-loaded");
    const errorMsg = dropzone.querySelector(".dropzone-error-msg");
    const fileNameEl = dropzone.querySelector(".dropzone-file-name");
    const fileMetaEl = dropzone.querySelector(".dropzone-file-meta");
    const btnReplace = dropzone.querySelector(".btn-replace");
    const btnRemove = dropzone.querySelector(".btn-remove");

    function showError(msg) {
      dropzone.classList.add("dropzone-error");
      if (errorMsg) {
        errorMsg.textContent = msg;
        errorMsg.style.display = "block";
      }
    }

    function clearError() {
      dropzone.classList.remove("dropzone-error");
      if (errorMsg) {
        errorMsg.textContent = "";
        errorMsg.style.display = "none";
      }
    }

    function resetToEmpty() {
      clearError();
      input.value = "";
      dropzone.classList.remove("is-loaded");
      if (emptyView) emptyView.style.display = "flex";
      if (loadedView) loadedView.style.display = "none";
      if (fileNameEl) fileNameEl.textContent = "";
      if (fileMetaEl) fileMetaEl.textContent = "";
      if (onFileCleared) onFileCleared();
    }

    function setLoadedFile(file) {
      clearError();
      dropzone.classList.add("is-loaded");
      if (emptyView) emptyView.style.display = "none";
      if (loadedView) loadedView.style.display = "flex";
      if (fileNameEl) fileNameEl.textContent = file.name;
      if (fileMetaEl)
        fileMetaEl.textContent = `${formatFileSize(file.size)} - [VALIDADO TÉCNICAMENTE]`;
      if (onFileSelected) onFileSelected(file);
    }

    function validateAndProcess(file) {
      if (!file) return;

      const validExtensions = /\.(pdf|jpe?g|png|webp|bmp|docx?)$/i;
      const isWordMime =
        file.type ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        file.type === "application/msword";
      const isMimeValid =
        file.type === "application/pdf" ||
        file.type.startsWith("image/") ||
        isWordMime;
      const isExtValid = validExtensions.test(file.name);

      if (!isMimeValid && !isExtValid) {
        resetToEmpty();
        showError(
          "[ERROR DE FORMATO]: Solo se admiten archivos PDF, DOCX, JPG o PNG",
        );
        return;
      }

      const maxBytes = maxSizeMB * 1024 * 1024;
      if (file.size > maxBytes) {
        resetToEmpty();
        showError(
          `[ERROR DE TAMAÑO]: Excede el límite de ${maxSizeMB}MB (${formatFileSize(file.size)})`,
        );
        return;
      }

      setLoadedFile(file);
    }

    // Clic en la caja abre selector si no está cargada
    dropzone.addEventListener("click", (e) => {
      if (e.target.closest(".btn-dropzone-action")) return;
      if (dropzone.classList.contains("is-loaded")) return;
      input.click();
    });

    if (btnReplace) {
      btnReplace.addEventListener("click", (e) => {
        e.stopPropagation();
        input.click();
      });
    }

    if (btnRemove) {
      btnRemove.addEventListener("click", (e) => {
        e.stopPropagation();
        resetToEmpty();
      });
    }

    input.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        validateAndProcess(file);
      }
    });

    // Eventos Drag & Drop con contador para evitar parpadeo en hijos
    let dragCounter = 0;
    dropzone.addEventListener("dragenter", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      dropzone.classList.add("drag-over");
    });

    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!dropzone.classList.contains("drag-over")) {
        dropzone.classList.add("drag-over");
      }
    });

    dropzone.addEventListener("dragleave", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropzone.classList.remove("drag-over");
      }
    });

    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      dropzone.classList.remove("drag-over");

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
      const res = await fetch("/api/positions");
      const data = await res.json();
      state.positions = data;
      positionSelect.innerHTML =
        '<option value="">Seleccione especialidad / cargo a postular...</option>' +
        data.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    } catch (err) {
      positionSelect.innerHTML =
        '<option value="">Error cargando cargos</option>';
    }
  }

  positionSelect.addEventListener("change", () => {
    const posId = parseInt(positionSelect.value, 10);
    const pos = state.positions.find((p) => p.id === posId);
    state.selectedPosition = pos || null;

    if (pos) {
      const minExp = pos.min_experience_years || 2;
      const credName =
        pos.required_credential || "Certificación Técnica Habilitante";
      const ecfCode = pos.ecf_code || "ECF Codelco / DS N° 132";
      ecfRequirementHint.innerHTML = `<strong>${ecfCode}:</strong> Exige mínimo <strong>${minExp} años de experiencia</strong> y adjuntar <strong>${credName}</strong>.`;
      ecfRequirementHint.style.color = "var(--primary)";
      labelCredencial.textContent = `${credName} *`;
      hintExp.textContent = `Mínimo exigido para este cargo: ${minExp} años de experiencia comprobable.`;
    }
  });

  // 2. Ejecutar lectura y validación de documentos en Fase 1 (Credencial Técnica + CV)
  async function triggerPhase1OCR() {
    // Si falta alguno de los dos documentos requeridos, guiar al postulante y esperar ambos para 1 solo análisis
    if (!state.credencialBase64 || !state.cvBase64) {
      if (state.credencialBase64 || state.cvBase64) {
        ocrLiveBanner.style.display = "flex";
        ocrLiveBanner.className = "ocr-banner ocr-banner-warn";
        ocrLiveIcon.className = "ocr-icon-static ocr-icon-info";
        ocrLiveIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
        const missingDoc = !state.credencialBase64
          ? "su Credencial Técnica"
          : "su Currículum Vitae (CV)";
        ocrLiveText.textContent = `Documentación en proceso (1 de 2). Por favor adjunte ${missingDoc} para continuar con la validación de sus antecedentes.`;
      } else {
        ocrLiveBanner.style.display = "none";
      }
      return;
    }

    if (state.isRunningOcr) {
      state.pendingOcrRerun = true;
      return;
    }

    state.isRunningOcr = true;
    state.pendingOcrRerun = false;
    ocrLiveBanner.style.display = "flex";
    ocrLiveBanner.className = "ocr-banner ocr-banner-loading";
    ocrLiveIcon.className = "ocr-spinner";
    ocrLiveIcon.innerHTML = "";
    ocrLiveText.textContent =
      "Validando antecedentes y verificando información en sus documentos adjuntos...";
    ocrFieldsContainer.style.display = "block";

    try {
      const res = await fetch("/api/ocr/phase1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          credencial_file: state.credencialBase64,
          cv_file: state.cvBase64,
          position_id: positionSelect ? positionSelect.value : null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Error analizando documentos.");
      }
      if (res.ok) {
        state.phase1OcrData = data;

        if (data.full_name && !fullNameInput.dataset.edited) {
          fullNameInput.value = formatTitleCase(data.full_name);
          if (data.name_discrepancia) {
            hintName.textContent =
              "Atención: El nombre en su CV difiere de su Credencial. Se priorizó la Credencial oficial.";
            hintName.style.color = "var(--safety-yellow)";
          } else if (data.name_source === "CREDENCIAL") {
            hintName.textContent =
              "Nombre oficial obtenido desde Licencia / Credencial Técnica";
            hintName.style.color = "var(--status-normal-text)";
          } else if (data.name_source === "AMBOS_COINCIDENTES") {
            hintName.textContent =
              "Nombre validado y coincidente en CV y Credencial Técnica";
            hintName.style.color = "var(--status-normal-text)";
          } else {
            hintName.textContent = "Nombre obtenido desde Currículum Vitae";
            hintName.style.color = "var(--status-normal-text)";
          }
        }

        if (data.rut_id && !rutInput.dataset.edited) {
          rutInput.value = formatRut(data.rut_id);
          if (data.rut_discrepancia) {
            hintRut.textContent = `Atención: El RUT en su CV difiere de su Credencial. Se priorizó la Credencial oficial.`;
            hintRut.style.color = "var(--safety-yellow)";
          } else if (data.rut_source === "CREDENCIAL") {
            hintRut.textContent =
              "RUT validado desde Licencia / Credencial Técnica";
            hintRut.style.color = "var(--status-normal-text)";
          } else if (data.rut_source === "AMBOS_COINCIDENTES") {
            hintRut.textContent =
              "RUT validado y coincidente en CV y Credencial Técnica";
            hintRut.style.color = "var(--status-normal-text)";
          } else {
            hintRut.textContent = "RUT obtenido desde Currículum Vitae";
            hintRut.style.color = "var(--status-normal-text)";
          }
        }

        if (data.email && !emailInput.dataset.edited) {
          emailInput.value = data.email;
          hintEmail.textContent = "Correo detectado en CV";
          hintEmail.style.color = "var(--status-normal-text)";
        }
        if (data.phone && !phoneInput.dataset.edited) {
          autoDetectPhonePrefix(data.phone);
          phoneInput.value = formatFlexiblePhone(data.phone);
          hintPhone.textContent = "Teléfono detectado en CV";
          hintPhone.style.color = "var(--status-normal-text)";
        }
        if (cityInput && !cityInput.dataset.edited) {
          if (data.city) {
            cityInput.value = data.city;
            if (hintCity) {
              hintCity.textContent = "Ciudad de residencia detectada en CV";
              hintCity.style.color = "var(--status-normal-text)";
            }
          } else {
            cityInput.value = "";
            if (hintCity) {
              hintCity.textContent =
                "Por favor indique su comuna de residencia";
              hintCity.style.color = "var(--text-muted)";
            }
          }
        }
        if (
          data.experience_years !== null &&
          data.experience_years !== undefined &&
          !expInput.dataset.edited
        ) {
          expInput.value = data.experience_years;
          if (
            data.experience_months !== null &&
            data.experience_months !== undefined
          ) {
            hintExp.textContent = `Experiencia estimada: ${data.experience_years} años (${data.experience_months} meses comprobables)`;
          } else {
            hintExp.textContent = `Experiencia laboral estimada: ${data.experience_years} años`;
          }
          hintExp.style.color = "var(--status-normal-text)";
        }

        // Actualizar campos de compatibilidad si existen en el DOM
        if (telemetryRut) telemetryRut.textContent = data.rut_id || "";
        if (telemetryCity) telemetryCity.textContent = data.city || "";
        if (telemetryExp)
          telemetryExp.textContent = `${data.experience_years || 0} años`;
        if (telemetryCred)
          telemetryCred.textContent = data.credencial_status || "VERIFICADA";

        const hasDiscrepancy = Boolean(
          data.rut_discrepancia || data.name_discrepancia,
        );
        if (hasDiscrepancy) {
          ocrLiveBanner.className = "ocr-banner ocr-banner-warn";
          ocrLiveIcon.className = "ocr-icon-static ocr-icon-warn";
          ocrLiveIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
          if (data.rut_discrepancia && data.name_discrepancia) {
            ocrLiveText.textContent = `Observación: El RUT y el Nombre en su CV difieren de su Credencial oficial. Se priorizó la Credencial oficial. Por favor revise y confirme sus datos.`;
          } else if (data.rut_discrepancia) {
            ocrLiveText.textContent = `Observación: El RUT en su CV (${data.rut_cv || "No detectado"}) difiere de su Credencial (${data.rut_credencial || "No detectado"}). Se consideró la Credencial oficial. Por favor confirme sus datos.`;
          } else {
            ocrLiveText.textContent = `Observación: El nombre en su CV (${data.name_cv || "No detectado"}) difiere de su Credencial (${data.name_credencial || "No detectado"}). Se consideró la Credencial oficial. Por favor confirme sus datos.`;
          }
        } else {
          ocrLiveBanner.className = "ocr-banner ocr-banner-done";
          ocrLiveIcon.className = "ocr-icon-static ocr-icon-done";
          ocrLiveIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
          ocrLiveText.textContent = `Documentos validados. La información ha sido cargada en el formulario; por favor revise y confirme sus datos antes de continuar.`;
        }
        unlockPhase1Inputs(false, hasDiscrepancy);
      } else {
        ocrLiveBanner.className = "ocr-banner ocr-banner-warn";
        ocrLiveIcon.className = "ocr-icon-static ocr-icon-info";
        ocrLiveIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
        ocrLiveText.textContent =
          "Por favor complete y confirme sus datos personales en el formulario a continuación.";
        unlockPhase1Inputs(true);
      }
    } catch (e) {
      ocrLiveBanner.className = "ocr-banner ocr-banner-warn";
      ocrLiveIcon.className = "ocr-icon-static ocr-icon-info";
      ocrLiveIcon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
      ocrLiveText.textContent =
        "Por favor complete y confirme sus datos personales directamente en el formulario.";
      unlockPhase1Inputs(true);
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
    dropzoneId: "dropzone-credencial",
    inputId: "file-credencial",
    onFileSelected: async (file) => {
      state.credencialBase64 = await fileToBase64(file);
      credencialStatus.textContent = `Credencial cargada: ${file.name}`;
      credencialStatus.style.color = "var(--ecf-emerald)";
      await triggerPhase1OCR();
    },
    onFileCleared: () => {
      state.credencialBase64 = null;
      credencialStatus.textContent =
        "Requisito: Carnet Rigger, WPQ o Licencia D según especialidad";
      credencialStatus.style.color = "";
      triggerPhase1OCR();
    },
  });

  // Fase 1: Currículum Vitae (CV)
  setupIndustrialDropzone({
    dropzoneId: "dropzone-cv",
    inputId: "file-cv",
    onFileSelected: async (file) => {
      state.cvBase64 = await fileToBase64(file);
      cvStatus.textContent = `CV cargado: ${file.name}`;
      cvStatus.style.color = "var(--ecf-emerald)";
      await triggerPhase1OCR();
    },
    onFileCleared: () => {
      state.cvBase64 = null;
      cvStatus.textContent =
        "Requisito: CV detallando fechas, faenas y experiencia en terreno";
      cvStatus.style.color = "";
      triggerPhase1OCR();
    },
  });

  // Marcar edición manual por el candidato y actualizar telemetría
  function bindManualEdit(inputEl, hintEl, label) {
    if (!inputEl) return;
    inputEl.addEventListener("input", () => {
      inputEl.dataset.edited = "true";
      ocrBadgeIndicator.textContent = "Verificado / Editado por Postulante";
      ocrBadgeIndicator.className = "status-pill status-Pendiente";
      if (hintEl) {
        hintEl.textContent = `${label} editado/confirmado manualmente`;
        hintEl.style.color = "var(--secondary)";
      }
      if (inputEl === rutInput && telemetryRut) {
        telemetryRut.textContent = rutInput.value.trim() || "NO DETECTADO";
      }
      if (inputEl === cityInput && telemetryCity) {
        telemetryCity.textContent = cityInput.value.trim() || "NO ESPECIFICADA";
      }
      if (inputEl === expInput && telemetryExp) {
        telemetryExp.textContent = `${expInput.value || 0} AÑOS (MANUAL)`;
      }
    });
  }

  bindManualEdit(fullNameInput, hintName, "Nombre");
  bindManualEdit(rutInput, hintRut, "RUT");
  bindManualEdit(emailInput, hintEmail, "Correo");
  bindManualEdit(phoneInput, hintPhone, "Teléfono");
  bindManualEdit(cityInput, hintCity, "Ciudad");
  bindManualEdit(expInput, hintExp, "Experiencia");

  /**
   * Formatea un RUT chileno dinámicamente con puntos y guion: XX.XXX.XXX-X
   * Solo acepta dígitos numéricos y letra K/k al final.
   */
  function formatRut(val) {
    if (!val) return "";
    let clean = val.replace(/[^0-9kK]/g, "");
    if (clean.length === 0) return "";
    if (clean.length > 9) clean = clean.slice(0, 9);
    if (clean.length === 1) return clean;

    const dv = clean.slice(-1).toUpperCase();
    let body = clean.slice(0, -1);
    let formattedBody = "";
    while (body.length > 3) {
      formattedBody = "." + body.slice(-3) + formattedBody;
      body = body.slice(0, -3);
    }
    formattedBody = body + formattedBody;
    return `${formattedBody}-${dv}`;
  }

  /**
   * Auto-detecta y selecciona el prefijo del país según el número extraído
   */
  function autoDetectPhonePrefix(val) {
    if (!val || !phonePrefixSelect) return;
    const str = String(val).trim();
    if (str.startsWith("+51")) {
      phonePrefixSelect.value = "+51";
    } else if (str.startsWith("+58")) {
      phonePrefixSelect.value = "+58";
    } else if (str.startsWith("+57")) {
      phonePrefixSelect.value = "+57";
    } else if (str.startsWith("+54")) {
      phonePrefixSelect.value = "+54";
    } else if (str.startsWith("+591")) {
      phonePrefixSelect.value = "+591";
    } else if (
      str.startsWith("+56") ||
      str.startsWith("56") ||
      str.startsWith("9") ||
      str.startsWith("72") ||
      str.startsWith("2")
    ) {
      phonePrefixSelect.value = "+56";
    } else if (str.startsWith("+")) {
      phonePrefixSelect.value = "other";
    }
  }

  /**
   * Formatea números telefónicos móviles, fijos e internacionales con flexibilidad
   */
  function formatFlexiblePhone(val) {
    if (!val) return "";
    const prefix = phonePrefixSelect ? phonePrefixSelect.value : "+56";
    if (prefix === "other") return String(val).trim();

    let digits = String(val).replace(/\D/g, "");
    if (!digits) return "";

    if (prefix === "+56") {
      // Si el usuario escribe o pega 56 al inicio y tiene más de 9 dígitos, quitarlo
      if (digits.startsWith("56") && digits.length > 9) {
        digits = digits.slice(2);
      }
      digits = digits.slice(0, 9);
      // Móvil chileno o red fija que parte con 9 o 2
      if (digits.startsWith("9") || digits.startsWith("2")) {
        if (digits.length <= 1) return digits;
        if (digits.length <= 5)
          return `${digits.slice(0, 1)} ${digits.slice(1)}`;
        return `${digits.slice(0, 1)} ${digits.slice(1, 5)} ${digits.slice(5)}`;
      }
      // Red fija regional (ej. 72 de O'Higgins/Rancagua, 32 Valparaíso, 41 Concepción)
      if (digits.length <= 2) return digits;
      if (digits.length <= 5) return `${digits.slice(0, 2)} ${digits.slice(2)}`;
      return `${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5)}`;
    }

    return digits.slice(0, 12);
  }

  if (rutInput) {
    rutInput.addEventListener("input", () => {
      const prev = rutInput.value;
      const formatted = formatRut(prev);
      rutInput.value = formatted;
      if (telemetryRut) {
        telemetryRut.textContent = formatted || "NO DETECTADO";
      }
    });
  }

  if (phoneInput) {
    phoneInput.addEventListener("input", () => {
      phoneInput.value = formatFlexiblePhone(phoneInput.value);
    });
  }

  if (phonePrefixSelect) {
    phonePrefixSelect.addEventListener("change", () => {
      phoneInput.value = formatFlexiblePhone(phoneInput.value);
      if (phonePrefixSelect.value === "other") {
        phoneInput.placeholder = "+56 9 8765 4321";
      } else {
        phoneInput.placeholder = "9 8765 4321";
      }
    });
  }

  if (fullNameInput) {
    fullNameInput.addEventListener("blur", () => {
      fullNameInput.value = formatTitleCase(fullNameInput.value);
    });
  }

  // 3. Cámara para Proctoring Transparente (Visible en todo momento)
  btnStartCamera.addEventListener("click", async () => {
    try {
      state.mediaStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });
      webcamView.srcObject = state.mediaStream;
      if (proctoringLiveVideo) {
        proctoringLiveVideo.srcObject = state.mediaStream;
      }
      btnTakeSelfie.disabled = false;
      btnStartCamera.textContent = "Cámara Visible Activa";
      btnStartCamera.disabled = true;
    } catch (err) {
      alert(
        "No se pudo acceder a la cámara web. Asegúrese de otorgar permisos en el navegador.",
      );
    }
  });

  btnTakeSelfie.addEventListener("click", () => {
    if (!state.mediaStream) return;
    const context = photoCanvas.getContext("2d");
    photoCanvas.width = webcamView.videoWidth || 640;
    photoCanvas.height = webcamView.videoHeight || 480;
    context.drawImage(webcamView, 0, 0, photoCanvas.width, photoCanvas.height);

    state.initialSelfieBase64 = photoCanvas.toDataURL("image/jpeg");
    selfiePreview.src = state.initialSelfieBase64;
    selfiePreview.style.display = "block";
    webcamView.style.display = "none";
    btnTakeSelfie.textContent = "Fotografía Registrada";
    btnTakeSelfie.classList.replace("btn-camera", "btn-success");
  });

  function goToStep(stepNum) {
    state.step = stepNum;
    wizardSteps.forEach((s, idx) => {
      s.style.display = idx + 1 === stepNum ? "block" : "none";
    });

    navItems.forEach((n, idx) => {
      if (idx + 1 === stepNum) {
        n.classList.add("active");
      } else if (idx + 1 < stepNum) {
        n.classList.remove("active");
        n.classList.add("completed");
      } else {
        n.classList.remove("active", "completed");
      }
    });

    // Ocultar tarjeta de requisitos iniciales de Fase 1 al entrar a Fase 2 o dictamen final
    const asideCardPhase1 = document.getElementById("aside-card-phase1-docs");
    if (asideCardPhase1) {
      asideCardPhase1.style.display = stepNum >= 3 ? "none" : "block";
    }

    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // 4. Fase 1 Submit -> Iniciar Fase 1.5 (Mini-Test Técnico de 5 preguntas)
  formStep1.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (state.isRunningOcr) {
      alert(
        "Por favor espere un momento a que finalice la verificación de sus documentos.",
      );
      return;
    }

    if (!state.credencialBase64 || !state.cvBase64) {
      alert(
        "Debe adjuntar su Credencial Técnica Habilitante y su Currículum Vitae (CV).",
      );
      return;
    }

    if (!state.initialSelfieBase64) {
      alert(
        "Por favor active su cámara y capture su fotografía antes de iniciar la evaluación técnica.",
      );
      return;
    }

    if (!consentProctoring.checked) {
      alert(
        "Debe aceptar el consentimiento informado para rendir la evaluación técnica.",
      );
      return;
    }

    const formattedName = formatTitleCase(fullNameInput.value);
    fullNameInput.value = formattedName;

    const prefix = phonePrefixSelect ? phonePrefixSelect.value : "+56";
    let fullPhone = "";
    if (prefix === "other") {
      fullPhone = phoneInput.value.trim();
    } else {
      const digits = phoneInput.value.replace(/[^\d\s]/g, "").trim();
      fullPhone = digits ? `${prefix} ${digits}`.trim() : "";
    }

    state.candidateData = {
      full_name: formattedName,
      rut_id: rutInput.value.trim(),
      email: emailInput.value.trim(),
      phone: fullPhone,
      city: cityInput.value.trim(),
      experience_years: parseInt(expInput.value || "0", 10),
      position_id: parseInt(positionSelect.value, 10),
    };

    try {
      const res = await fetch(
        `/api/positions/${state.candidateData.position_id}/questions`,
      );
      const data = await res.json();
      state.questions = data.questions || [];

      if (state.questions.length === 0) {
        alert("No hay preguntas configuradas para esta especialidad.");
        return;
      }

      goToStep(2);
      startMiniTest();
    } catch (err) {
      alert("Error cargando el Mini-Test Técnico.");
    }
  });

  // 5. Lógica del Mini-Test Técnico (Fase 1.5)
  function startMiniTest() {
    state.currentQuestionIndex = 0;
    state.answers = [];
    state.randomCaptureQuestionIndex = Math.floor(Math.random() * 3) + 1;
    state.randomSelfieCaptured = false;
    state.randomSelfieBase64 = null;
    qTotal.textContent = state.questions.length;
    showQuestion(0);
  }

  function captureRandomSelfie() {
    if (state.randomSelfieCaptured || !state.mediaStream) return;
    try {
      const videoSource =
        (proctoringLiveVideo &&
          proctoringLiveVideo.videoWidth > 0 &&
          proctoringLiveVideo) ||
        webcamView;
      if (!videoSource) return;
      const ctx = photoCanvas.getContext("2d");
      photoCanvas.width = videoSource.videoWidth || 640;
      photoCanvas.height = videoSource.videoHeight || 480;
      ctx.drawImage(videoSource, 0, 0, photoCanvas.width, photoCanvas.height);
      state.randomSelfieBase64 = photoCanvas.toDataURL("image/jpeg", 0.7);
      state.randomSelfieCaptured = true;
    } catch (err) {
      console.warn(
        "No se pudo capturar selfie proctoring en segundo plano:",
        err,
      );
    }
  }

  function showQuestion(index) {
    if (index >= state.questions.length) {
      clearInterval(state.timerInterval);
      submitPhase1AndEvaluate();
      return;
    }

    // Disparo automático de selfie en segundo plano durante el mini-test
    if (
      index === state.randomCaptureQuestionIndex &&
      !state.randomSelfieCaptured &&
      state.mediaStream
    ) {
      setTimeout(captureRandomSelfie, 400);
    }

    const q = state.questions[index];
    qCurrent.textContent = index + 1;
    questionText.textContent = q.question_text;

    const isSjt = q.category === "SJT";
    const catHtml = isSjt
      ? `<span class="mining-tag" style="background: rgba(255, 184, 0, 0.15); color: var(--safety-yellow); border-color: var(--safety-yellow); margin-bottom: 0.5rem; display: inline-block;">[CASO SJT: SEGURIDAD CRÍTICA / ECF CODELCO]</span><br>`
      : `<span class="mining-tag" style="color: var(--text-secondary); margin-bottom: 0.5rem; display: inline-block;">[IDONEIDAD TÉCNICA ESPECÍFICA]</span><br>`;

    const progressEl = document.querySelector(".question-progress");
    if (progressEl) {
      progressEl.innerHTML = `${catHtml}Pregunta ${index + 1} de ${state.questions.length}`;
    }

    optionsContainer.innerHTML = [
      { key: "A", text: q.option_a },
      { key: "B", text: q.option_b },
      { key: "C", text: q.option_c },
      { key: "D", text: q.option_d },
    ]
      .map(
        (opt) => `
      <button type="button" class="option-btn" data-key="${opt.key}">
        <strong>${opt.key})</strong> ${opt.text}
      </button>
    `,
      )
      .join("");

    let selectedOption = null;
    document.querySelectorAll(".option-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll(".option-btn")
          .forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        selectedOption = btn.dataset.key;

        if (
          index === state.randomCaptureQuestionIndex &&
          !state.randomSelfieCaptured &&
          state.mediaStream
        ) {
          captureRandomSelfie();
        }
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
        recordAnswerAndAdvance(selectedOption || "N/A");
      }
    }, 1000);

    btnNextQuestion.onclick = () => {
      clearInterval(state.timerInterval);
      recordAnswerAndAdvance(selectedOption || "N/A");
    };
  }

  function recordAnswerAndAdvance(selectedOption) {
    const q = state.questions[state.currentQuestionIndex];
    state.answers.push({
      question_id: q.id,
      selected_option: selectedOption,
    });
    state.currentQuestionIndex++;
    showQuestion(state.currentQuestionIndex);
  }

  // 6. Evaluar Fase 1 + 1.5 y decidir si desbloquea Fase 2 (Pre-Acreditación) o Descarta Técnicamente
  async function submitPhase1AndEvaluate() {
    btnNextQuestion.disabled = true;
    btnNextQuestion.textContent = "Evaluando Filtro Técnico ECF...";

    if (!state.randomSelfieCaptured && state.mediaStream) {
      captureRandomSelfie();
    }

    // Detener stream de cámara tras finalizar el Mini-Test
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((t) => t.stop());
    }

    try {
      const res = await fetch("/api/candidates/phase1-submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...state.candidateData,
          cv_file: state.cvBase64,
          credencial_file: state.credencialBase64,
          initial_selfie: state.initialSelfieBase64,
          random_selfie: state.randomSelfieBase64 || null,
          consent_proctoring: true,
          answers: state.answers,
          phase1_ocr_data: state.phase1OcrData,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        alert(`Error al evaluar Fase 1: ${data.error}`);
        return;
      }

      state.candidateId = data.candidateId;

      if (data.status === "PRESELECCIONADO") {
        // PRESELECCIONADO: Evaluación técnica aprobada, en espera de aprobación de cupo por RR.HH.
        finalIcon.textContent = "ESTADO: PRESELECCIONADO TÉCNICAMENTE";
        finalIcon.className = "status-pill status-Aprobado";
        finalTitle.textContent =
          "Evaluación Técnica Aprobada — En Espera de Cupo para Faena";
        finalSubtitle.textContent =
          "Su postulación ha sido calificada conforme y se encuentra en revisión por el equipo de RR.HH. de Nexxo S.A. para asignación de cupo en División El Teniente.";

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

          <div style="margin-top: 1.25rem; text-align: left; background: var(--surface-panel); border: 1px solid var(--safety-yellow); border-left: 4px solid var(--safety-yellow); color: var(--text-primary); padding: 1.25rem; border-radius: var(--radius-terminal); font-size: 0.88rem; font-family: 'IBM Plex Mono', monospace;">
            <strong style="color: var(--safety-yellow);">ETAPA ACTUAL: ASIGNACIÓN DE DOTACIÓN POR RR.HH.</strong><br><br>
            Ha calificado técnicamente para la parada de planta en <strong>División El Teniente</strong>.<br><br>
            <strong>Próximos Pasos Normativos:</strong><br>
            1. El equipo de Reclutamiento y Acreditación de Nexxo S.A. validará los cupos de dotación disponibles.<br>
            2. Una vez <strong>aprobado su acceso a faena</strong>, recibirá automáticamente un <strong>enlace de acceso seguro (Magic Link)</strong> en su correo electrónico (<strong>${state.candidateData.email || "declarado"}</strong>).<br>
            3. Mediante ese enlace exclusivo podrá ingresar a la <strong>Fase 02 (Validación Documental)</strong> para adjuntar su Cédula de Identidad y Certificado de Antecedentes (Vigencia &le; 60 días).<br><br>
            <em>En estricto cumplimiento de la Ley N° 19.628 y la normativa laboral de la Dirección del Trabajo, su documentación penal no es requerida hasta que cuente con aprobación formal de cupo de faena.</em>
          </div>
        `;
        goToStep(4);
      } else {
        // DESCARTADO_TECNICO: Mostrar feedback normativo inmediato sin pedir Carnet ni Antecedentes
        finalIcon.textContent = "ESTADO: DESCARTADO TÉCNICO";
        finalIcon.className = "status-pill status-Rechazado";
        finalTitle.textContent =
          "Resultado Filtro Técnico: No Califica en esta Convocatoria";
        finalSubtitle.textContent =
          "Su postulación no alcanzó el umbral técnico o de apego a normas de seguridad crítica exigido por los ECF de Codelco.";
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
              <span class="value" style="color: ${data.sjt_conforme ? "var(--ecf-emerald)" : "var(--ecf-crimson)"}; font-weight: 800;">
                [${data.sjt_conforme ? "CONFORME (2/2)" : "NO CONFORME"}]
              </span>
            </div>
            <div class="info-item">
              <span class="label">Veredicto Final</span>
              <span class="status-pill status-Rechazado">[${data.status}]</span>
            </div>
          </div>
          <div style="margin-top: 1.25rem; text-align: left; background: var(--surface-panel); border: 1px solid var(--ecf-crimson-border); border-left: 4px solid var(--ecf-crimson); color: var(--text-primary); padding: 1rem; border-radius: var(--radius-terminal); font-size: 0.88rem; font-family: 'IBM Plex Mono', monospace;">
            <strong style="color: var(--ecf-crimson);">DIAGNÓSTICO DEL DESCARTE AUTOMÁTICO:</strong><br>
            ${(data.rejectionReasons || []).map((r) => `• ${r}`).join("<br>")}
          </div>
          <p style="margin-top: 1rem; color: var(--text-muted); font-size: 0.82rem; font-family: 'IBM Plex Mono', monospace;">
            En estricto cumplimiento de la normativa laboral (Dirección del Trabajo y Ley N° 19.628), no se le ha solicitado Cédula de Identidad ni Certificado de Antecedentes Penales.
          </p>
        `;
        goToStep(4);
      }
    } catch (err) {
      alert("Error de conexión al evaluar el Mini-Test.");
    } finally {
      btnNextQuestion.disabled = false;
      btnNextQuestion.textContent = "Confirmar Respuesta y Siguiente";
    }
  }

  // 7. Fase 2 & 3: Subida de Carnet + Antecedentes y Motor OCR de Validación Cruzada
  setupIndustrialDropzone({
    dropzoneId: "dropzone-carnet-front",
    inputId: "file-carnet-front",
    onFileSelected: async (file) => {
      state.carnetFrontBase64 = await fileToBase64(file);
      carnetFrontStatus.textContent = `Cédula Frente cargada: ${file.name}`;
      carnetFrontStatus.style.color = "var(--ecf-emerald)";
    },
    onFileCleared: () => {
      state.carnetFrontBase64 = null;
      carnetFrontStatus.textContent =
        "[ESCANEO: Valida RUT, Nombre y Vigencia]";
      carnetFrontStatus.style.color = "";
    },
  });

  setupIndustrialDropzone({
    dropzoneId: "dropzone-carnet-back",
    inputId: "file-carnet-back",
    onFileSelected: async (file) => {
      state.carnetBackBase64 = await fileToBase64(file);
      carnetBackStatus.textContent = `Cédula Reverso cargada: ${file.name}`;
      carnetBackStatus.style.color = "var(--ecf-emerald)";
    },
    onFileCleared: () => {
      state.carnetBackBase64 = null;
      carnetBackStatus.textContent = "[ESCANEO: Reverso del documento]";
      carnetBackStatus.style.color = "";
    },
  });

  setupIndustrialDropzone({
    dropzoneId: "dropzone-antecedentes",
    inputId: "file-antecedentes",
    onFileSelected: async (file) => {
      state.antecedentesBase64 = await fileToBase64(file);
      antecedentesStatus.textContent = `Cert. Antecedentes cargado: ${file.name}`;
      antecedentesStatus.style.color = "var(--ecf-emerald)";
    },
    onFileCleared: () => {
      state.antecedentesBase64 = null;
      antecedentesStatus.textContent = "[REGISTRO CIVIL: Vigencia ≤ 60 días]";
      antecedentesStatus.style.color = "";
    },
  });

  formPhase2.addEventListener("submit", async (e) => {
    e.preventDefault();

    if (!state.carnetFrontBase64 || !state.antecedentesBase64) {
      alert(
        "Por favor adjunte la foto de su Cédula de Identidad y su Certificado de Antecedentes.",
      );
      return;
    }

    if (!consentLey19628.checked) {
      alert(
        "Debe marcar la casilla de Consentimiento Expreso (Ley N° 19.628) para continuar.",
      );
      return;
    }

    btnSubmitPhase2.disabled = true;
    btnSubmitPhase2.textContent = "Guardando antecedentes y finalizando...";

    try {
      const res = await fetch(
        `/api/candidates/${state.candidateId}/phase2-acreditacion`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            carnet_file: state.carnetFrontBase64,
            carnet_back_file: state.carnetBackBase64,
            antecedentes_file: state.antecedentesBase64,
            consent_ley19628: true,
          }),
        },
      );

      const data = await res.json();
      if (!res.ok) {
        alert(`Error en Pre-Acreditación: ${data.error}`);
        btnSubmitPhase2.disabled = false;
        btnSubmitPhase2.textContent =
          "Enviar Documentación y Finalizar Postulación";
        return;
      }

      const isPreAcreditado = data.status === "PRE_ACREDITADO";
      finalIcon.textContent = isPreAcreditado
        ? "ESTADO: PRE-ACREDITADO"
        : "ESTADO: EN REVISIÓN";
      finalIcon.className = `status-pill ${isPreAcreditado ? "status-Aprobado" : "status-Pendiente"}`;
      finalTitle.textContent = isPreAcreditado
        ? "Documentación Pre-Acreditada para División El Teniente"
        : "Documentación Recibida — En Revisión por RR.HH.";
      finalSubtitle.textContent = isPreAcreditado
        ? "Su documentación ha sido verificada exitosamente. Su carpeta de acreditación está lista para revisión de faena."
        : "Sus documentos fueron recibidos correctamente. El equipo de Selección revisará los antecedentes para coordinar su ingreso.";

      resultSummary.innerHTML = `
        <div class="info-grid">
          <div class="info-item">
            <span class="label">Folio de Postulación</span>
            <span class="value">#${data.candidateId}</span>
          </div>
          <div class="info-item">
            <span class="label">Vigencia Cédula</span>
            <span class="value">${data.ocrCarnetVigencia || "Vigente"}</span>
          </div>
          <div class="info-item">
            <span class="label">Certificado de Antecedentes</span>
            <span class="value">${data.ocrAntecedentesStatus || "Recibido"}</span>
          </div>
          <div class="info-item">
            <span class="label">Estado de la Solicitud</span>
            <span class="status-pill ${isPreAcreditado ? "status-Aprobado" : "status-Pendiente"}">${isPreAcreditado ? "PRE-ACREDITADO" : "EN REVISIÓN"}</span>
          </div>
        </div>
        ${
          data.discrepancies && data.discrepancies.length > 0
            ? `
          <div style="margin-top: 1.25rem; text-align: left; background: var(--status-warning-bg); border: 1px solid var(--status-warning-border); color: var(--status-warning-text); padding: 1rem; border-radius: var(--radius-standard); font-size: 0.88rem;">
            <strong>Observación para mesa de selección Nexxo:</strong><br>
            ${data.discrepancies.join("<br>")}
          </div>
        `
            : `
          <div style="margin-top: 1.25rem; text-align: left; background: var(--status-normal-bg); border: 1px solid var(--status-normal-border); color: var(--status-normal-text); padding: 1rem; border-radius: var(--radius-standard); font-size: 0.88rem;">
            <strong>Validación de Identidad Conforme:</strong> El RUT y Nombre de su Cédula coinciden con sus antecedentes y especialidad técnica.
          </div>
        `
        }
      `;

      goToStep(4);
    } catch (err) {
      alert("Error de conexión al procesar la documentación.");
      btnSubmitPhase2.disabled = false;
      btnSubmitPhase2.textContent =
        "Enviar Documentación y Finalizar Postulación";
    }
  });

  async function checkAccessTokenAndResume() {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get("token");
    if (!token) return;

    try {
      const res = await fetch(
        `/api/candidates/access/${encodeURIComponent(token)}`,
      );
      const data = await res.json();
      if (!res.ok) {
        alert(
          `[ACCESO A FAENA NO AUTORIZADO]\n\n${data.error || "El enlace no es válido o requiere aprobación de faena previa por parte de RR.HH."}`,
        );
        return;
      }

      state.candidateId = data.id;
      state.candidateData = data;

      // Control de Reingreso: Si el postulante ya envió sus antecedentes previamente, no mostrar formulario vacío
      const isAlreadySubmitted = Boolean(
        data.phase2_submitted_at ||
        data.token_used_at ||
        data.carnet_file ||
        [
          "PRE_ACREDITADO",
          "EN_REVISION_MANUAL",
          "CONTRATADO_FAENA",
          "DESCARTADO_TECNICO",
        ].includes(data.status),
      );

      if (isAlreadySubmitted) {
        goToStep(4);

        if (data.status === "CONTRATADO_FAENA") {
          finalIcon.textContent = "ESTADO: CONTRATADO FAENA";
          finalIcon.className = "status-pill status-Aprobado";
          finalTitle.textContent =
            "Acreditación Aprobada — Contratado para Faena";
          finalSubtitle.textContent =
            "Su documentación fue aprobada y cuenta con asignación oficial a la parada de planta en Codelco División El Teniente. El equipo de Operaciones se contactará para coordinar inducción y exámenes.";
        } else if (data.status === "PRE_ACREDITADO") {
          finalIcon.textContent = "ESTADO: PRE-ACREDITADO";
          finalIcon.className = "status-pill status-Aprobado";
          finalTitle.textContent =
            "Documentación Pre-Acreditada para División El Teniente";
          finalSubtitle.textContent =
            "Su documentación ha sido verificada exitosamente. Su carpeta de acreditación está a la espera de la asignación final de cupo por parte de RR.HH.";
        } else if (data.status === "EN_REVISION_MANUAL") {
          finalIcon.textContent = "ESTADO: EN REVISIÓN";
          finalIcon.className = "status-pill status-Pendiente";
          finalTitle.textContent =
            "Documentación Recibida — En Revisión por RR.HH.";
          finalSubtitle.textContent =
            "Sus documentos fueron recibidos correctamente. El equipo de Selección está auditando su expediente normativo.";
        } else if (data.status === "DESCARTADO_TECNICO") {
          finalIcon.textContent = "ESTADO: PROCESO FINALIZADO";
          finalIcon.className = "status-pill status-Descartado";
          finalTitle.textContent = "Postulación Concluida";
          finalSubtitle.textContent =
            "El proceso de selección para esta convocatoria ha concluido. Sus antecedentes han quedado archivados para futuros llamados operativos.";
        } else {
          finalIcon.textContent = "ESTADO: EN PROCESO";
          finalIcon.className = "status-pill status-Pendiente";
          finalTitle.textContent = "Documentación Ingresada";
          finalSubtitle.textContent =
            "Sus antecedentes han sido ingresados y se encuentran en proceso de tramitación.";
        }

        const isPreAcreditado =
          data.status === "PRE_ACREDITADO" ||
          data.status === "CONTRATADO_FAENA";
        resultSummary.innerHTML = `
          <div class="info-grid">
            <div class="info-item">
              <span class="label">Folio de Postulación</span>
              <span class="value">#${data.id}</span>
            </div>
            <div class="info-item">
              <span class="label">Vigencia Cédula</span>
              <span class="value">${data.ocr_carnet_vigencia || "Vigente"}</span>
            </div>
            <div class="info-item">
              <span class="label">Certificado de Antecedentes</span>
              <span class="value">${data.ocr_antecedentes_status || "Recibido"}</span>
            </div>
            <div class="info-item">
              <span class="label">Estado de la Solicitud</span>
              <span class="status-pill ${isPreAcreditado ? "status-Aprobado" : "status-Pendiente"}">${data.status.replace(/_/g, " ")}</span>
            </div>
          </div>
          ${
            data.discrepancy_notes && data.status === "EN_REVISION_MANUAL"
              ? `
            <div style="margin-top: 1.25rem; text-align: left; background: var(--status-warning-bg); border: 1px solid var(--status-warning-border); color: var(--status-warning-text); padding: 1rem; border-radius: var(--radius-standard); font-size: 0.88rem;">
              <strong>Observación para mesa de selección Nexxo:</strong><br>
              ${escapeHtml(data.discrepancy_notes)}
            </div>
          `
              : `
            <div style="margin-top: 1.25rem; text-align: left; background: var(--status-normal-bg); border: 1px solid var(--status-normal-border); color: var(--status-normal-text); padding: 1rem; border-radius: var(--radius-standard); font-size: 0.88rem;">
              <strong>Expediente Registrado:</strong> Su información y antecedentes personales se encuentran debidamente resguardados bajo la Ley N° 19.628 para fines de acreditación minera.
            </div>
          `
          }
        `;
        return;
      }

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
      const bannerContainer = document.createElement("div");
      bannerContainer.className = "ocr-banner ocr-banner-done";
      bannerContainer.style.marginBottom = "1.25rem";
      bannerContainer.innerHTML = `
        <strong style="font-family: 'IBM Plex Mono', monospace;">[ACCESO A FAENA APROBADO]</strong>
        <span>Bienvenido/a <strong>${data.full_name}</strong>. Su cupo ha sido autorizado por RR.HH. Ingrese su Cédula y Certificado de Antecedentes para conformar su Carpeta WebControl Codelco.</span>
      `;

      const formPhase2El = document.getElementById("form-phase2");
      if (formPhase2El && formPhase2El.parentNode) {
        formPhase2El.parentNode.insertBefore(bannerContainer, formPhase2El);
      }

      // Medida de Seguridad: Si quien abre el enlace es un Administrador con sesión activa
      const isAdminSession = Boolean(
        sessionStorage.getItem("nexxo_admin_token"),
      );
      if (isAdminSession) {
        const adminWarningBanner = document.createElement("div");
        adminWarningBanner.className = "ocr-banner ocr-banner-warning";
        adminWarningBanner.style.marginBottom = "1.25rem";
        adminWarningBanner.innerHTML = `
          <strong style="font-family: 'IBM Plex Mono', monospace;">[MODO SUPERVISIÓN ADMINISTRATIVA]</strong>
          <span>Ha ingresado con una sesión activa de Administrador. Por trazabilidad legal y transparencia (Ley N° 19.628), un evaluador no puede cargar antecedentes en nombre del postulante. La carga de archivos ha sido inhabilitada.</span>
        `;
        if (formPhase2El && formPhase2El.parentNode) {
          formPhase2El.parentNode.insertBefore(
            adminWarningBanner,
            formPhase2El,
          );
        }

        // Inhabilitar controles de carga y botón de envío
        const btnSubmitPhase2 = document.getElementById("btn-submit-phase2");
        if (btnSubmitPhase2) {
          btnSubmitPhase2.disabled = true;
          btnSubmitPhase2.textContent =
            "[CARGA INHABILITADA PARA ADMINISTRADORES]";
          btnSubmitPhase2.style.opacity = "0.6";
          btnSubmitPhase2.style.cursor = "not-allowed";
        }
        const fileInputs = formPhase2El
          ? formPhase2El.querySelectorAll('input[type="file"]')
          : [];
        fileInputs.forEach((fi) => (fi.disabled = true));
        const consentCheckbox = document.getElementById("consent-ley19628");
        if (consentCheckbox) consentCheckbox.disabled = true;
      }
    } catch (e) {
      console.error("[Error verificando token de acceso]:", e);
    }
  }

  loadPositions();
  checkAccessTokenAndResume();
});
