-- 001 — Esquema de referencia (baseline) de NEXXO.
-- Representa las tablas tal como las dejaba initDB() en una instalación nueva.
-- En una BD vacía se ejecuta; en una BD existente NO se ejecuta: el ejecutor verifica
-- que el esquema coincida y solo entonces la registra (ver src/db/migrate.js).
-- No editar una vez aplicada: los cambios de esquema van en migraciones nuevas.
-- Sin CHARSET/COLLATE explícitos: se usa el predeterminado del servidor, igual que antes.

CREATE TABLE positions (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  required_credential VARCHAR(150) DEFAULT NULL,
  min_experience_years INT DEFAULT 2,
  ecf_code VARCHAR(80) DEFAULT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE questions (
  id INT NOT NULL AUTO_INCREMENT,
  position_id INT DEFAULT NULL,
  question_text TEXT NOT NULL,
  option_a VARCHAR(255) NOT NULL,
  option_b VARCHAR(255) NOT NULL,
  option_c VARCHAR(255) NOT NULL,
  option_d VARCHAR(255) NOT NULL,
  correct_option CHAR(1) NOT NULL,
  category VARCHAR(30) DEFAULT 'TECNICA',
  PRIMARY KEY (id),
  CONSTRAINT questions_ibfk_1 FOREIGN KEY (position_id) REFERENCES positions (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE candidates (
  id INT NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(150) NOT NULL,
  rut_id VARCHAR(50) NOT NULL,
  age INT DEFAULT 30,
  position_id INT NOT NULL,
  cert_file VARCHAR(255) DEFAULT NULL,
  antecedentes_file VARCHAR(255) DEFAULT NULL,
  initial_selfie VARCHAR(255) DEFAULT NULL,
  random_selfie VARCHAR(255) DEFAULT NULL,
  facial_match_ok TINYINT(1) DEFAULT NULL,
  facial_confidence INT DEFAULT NULL,
  score INT DEFAULT 0,
  total_questions INT DEFAULT 0,
  audio_file VARCHAR(255) DEFAULT NULL,
  status VARCHAR(50) DEFAULT 'POSTULADO',
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  email VARCHAR(150) DEFAULT NULL,
  phone VARCHAR(50) DEFAULT NULL,
  city VARCHAR(100) DEFAULT NULL,
  experience_years INT DEFAULT 0,
  cv_file VARCHAR(255) DEFAULT NULL,
  credencial_file VARCHAR(255) DEFAULT NULL,
  carnet_file VARCHAR(255) DEFAULT NULL,
  carnet_back_file VARCHAR(255) DEFAULT NULL,
  ocr_text TEXT,
  ocr_birth_date VARCHAR(50) DEFAULT NULL,
  ocr_detected_age INT DEFAULT NULL,
  ocr_verified TINYINT(1) DEFAULT 0,
  ocr_detected_name VARCHAR(150) DEFAULT NULL,
  ocr_detected_rut VARCHAR(50) DEFAULT NULL,
  ocr_credencial_status VARCHAR(100) DEFAULT NULL,
  ocr_antecedentes_status VARCHAR(80) DEFAULT NULL,
  ocr_carnet_vigencia VARCHAR(80) DEFAULT NULL,
  ocr_cross_check_ok TINYINT(1) DEFAULT 0,
  ocr_manually_edited TINYINT(1) DEFAULT 0,
  ocr_edited_fields VARCHAR(255) DEFAULT NULL,
  discrepancy_notes TEXT,
  consent_proctoring TINYINT(1) DEFAULT 0,
  consent_ley19628 TINYINT(1) DEFAULT 0,
  score_tecnico INT DEFAULT 0,
  score_sjt INT DEFAULT 0,
  sjt_conforme TINYINT(1) DEFAULT 0,
  access_token VARCHAR(64) DEFAULT NULL,
  token_expires_at DATETIME DEFAULT NULL,
  token_used_at DATETIME DEFAULT NULL,
  phase2_submitted_at DATETIME DEFAULT NULL,
  experience_years_in_role INT DEFAULT 0,
  role_fit_percentage INT DEFAULT 0,
  detected_skills TEXT,
  role_fit_verdict VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_candidates_access_token (access_token),
  CONSTRAINT candidates_ibfk_1 FOREIGN KEY (position_id) REFERENCES positions (id)
) ENGINE=InnoDB;

CREATE TABLE candidate_answers (
  id INT NOT NULL AUTO_INCREMENT,
  candidate_id INT NOT NULL,
  question_id INT NOT NULL,
  selected_option CHAR(1) NOT NULL,
  is_correct TINYINT(1) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT candidate_answers_ibfk_1 FOREIGN KEY (candidate_id) REFERENCES candidates (id) ON DELETE CASCADE,
  CONSTRAINT candidate_answers_ibfk_2 FOREIGN KEY (question_id) REFERENCES questions (id)
) ENGINE=InnoDB;

-- Respaldo de archivos subidos (el disco de Cloud Run es efímero).
CREATE TABLE file_storage (
  id INT NOT NULL AUTO_INCREMENT,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) DEFAULT NULL,
  file_data LONGBLOB NOT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY filename (filename)
) ENGINE=InnoDB;

CREATE TABLE admin_users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(50) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  role VARCHAR(30) DEFAULT 'RRHH',
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY username (username)
) ENGINE=InnoDB;

CREATE TABLE admin_sessions (
  token_hash CHAR(64) NOT NULL,
  admin_id INT NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token_hash),
  KEY idx_admin_sessions_admin (admin_id)
) ENGINE=InnoDB;

-- @tidb-only: AUTO_ID_CACHE no existe en MySQL. En TiDB Serverless evita saltos de ~30.000 en los folios.
ALTER TABLE candidates AUTO_ID_CACHE = 10;
