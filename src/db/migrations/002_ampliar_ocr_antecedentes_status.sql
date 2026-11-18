-- 002 — Iguala candidates.ocr_antecedentes_status a VARCHAR(80).
-- En bases antiguas la columna quedó en VARCHAR(60) porque el ALTER de initDB() fallaba
-- en silencio al existir ya la columna. Ampliar no pierde datos; en instalaciones nuevas no cambia nada.

ALTER TABLE candidates MODIFY COLUMN ocr_antecedentes_status VARCHAR(80) DEFAULT NULL;
