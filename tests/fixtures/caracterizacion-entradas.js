/**
 * Entradas SINTÉTICAS para las pruebas de caracterización (tests/unit/caracterizacion.test.js).
 * Todos los nombres, RUT, correos y teléfonos son ficticios (correos en el dominio reservado .invalid).
 * No agregar documentos reales de postulantes (Ley N° 19.628).
 */

const CV_RIGGER = `[PDF_HEADER_NAME]: Juan Pablo Pérez Soto
JUAN PABLO PÉREZ SOTO
Rigger / Maniobrista Certificado
RUT: 12.345.678-5
Correo: juan.perez@example.invalid
Teléfono: +56 9 8765 4321
Dirección: Pasaje Los Aromos 123, Rancagua

PERFIL PROFESIONAL
Rigger con experiencia en maniobras de izaje en faenas mineras. Certificación ChileValora B30.5.

EXPERIENCIA LABORAL
Constructora Andes Ltda. — Rigger
Marzo 2018 - Actualidad
Maniobras con grúas de hasta 250 toneladas.

Montajes del Sur SpA — Ayudante de maniobras
01/2014 - 02/2018

EDUCACIÓN
Liceo Industrial de Rancagua 2008 - 2012

REFERENCIAS
Pedro Antonio Muñoz Díaz — Supervisor
RUT 11.111.111-1 — Teléfono +56 9 1111 2222
2001 - 2015`;

const CV_SOLDADOR = `MARÍA JOSÉ GONZÁLEZ ROJAS
Soldadora calificada AWS 6G (SMAW / TIG)
maria.gonzalez@example.invalid | 9 7654 3210 | Antofagasta

RESUMEN
Más de 12 años de experiencia en soldadura de cañerías y estructuras.

EXPERIENCIA
Metalúrgica Norte S.A. | Soldadora 6G | Enero 2015 – Diciembre 2022
Servicios Industriales Atacama | Soldadora 3G | 2010 - 2014

CERTIFICACIONES
WPQ AWS D1.1 vigente hasta 2027

FORMACIÓN ACADÉMICA
Técnico en Soldadura, CFT Regional 2007 - 2009`;

const CV_OPERADOR = `Curriculum Vitae
Nombre completo: Carlos Andrés Fuentes Vera
RUN 15.432.198-K
Fecha de nacimiento: 15 de marzo de 1985
Licencia de conducir Clase D y A4. Operador de maquinaria pesada: excavadora y cargador frontal.
Celular: (+56) 9-5555-4444
Ciudad: Calama

EXPERIENCIA PROFESIONAL
2019 - 2023 Operador de excavadora, Áridos del Norte
06/2016 – 12/2018 Operador cargador frontal, Movimientos de Tierra Ltda.

ESTUDIOS
Enseñanza media completa`;

const CV_DOS_COLUMNAS = `ANA BELÉN TORRES MUÑOZ          EXPERIENCIA
Prevencionista de riesgos       Minera Ficticia Uno   2020 - presente
ana.torres@example.invalid      Asesora en prevención de riesgos
Contacto: 9 4444 3333           Contratista Dos       2017 - 2020
Copiapó                         Supervisora HSE
HABILIDADES                     EDUCACIÓN
Liderazgo, ISO 45001            Universidad Ficticia de Atacama 2012 - 2016`;

const CV_CON_INSTITUCIONES = `Universidad Adolfo Ibáñez
Constructora Miguel Morales
Ingeniero Constructor
Nombre: Roberto Ignacio Salinas Paredes
roberto.salinas@example.invalid
Experiencia: 5 años como jefe de terreno.
Referencias: Gerente General Constructora Miguel Morales`;

const CV_SIN_SECCIONES = `luis alberto ramírez campos
maestro eléctrico sec clase a
luis.ramirez@example.invalid
trabajé en mantención eléctrica desde 2012 hasta 2021 en distintas empresas de la zona de talca`;

// Meses abreviados en rangos (ENE, FEB, MAR, ABR, MAY, JUN, JUL, AGO, SEP, SEPT, OCT, NOV, DIC).
const CV_MESES_ABREVIADOS = `FELIPE ANDRÉS ROJAS LAGOS
Mecánico de equipos pesados
felipe.rojas@example.invalid
Puerto Montt

EXPERIENCIA LABORAL
Taller Uno | Ene 2010 - Feb 2011
Taller Dos | Mar 2011 - Abr 2012
Taller Tres | May 2012 - Jun 2013
Taller Cuatro | Jul 2013 - Ago 2014
Taller Cinco | Sep 2014 - Oct 2015
Taller Seis | Sept 2015 - Nov 2016
Taller Siete | Dic 2016 - Mar 2019

EDUCACIÓN
Liceo Técnico 2005 - 2008`;

const CEDULA_FRENTE_VIGENTE = `REPUBLICA DE CHILE
SERVICIO DE REGISTRO CIVIL E IDENTIFICACION
CEDULA DE IDENTIDAD
APELLIDOS
GONZALEZ ROJAS
NOMBRES
MARIA JOSE
NACIONALIDAD CHILENA SEXO F
FECHA DE NACIMIENTO 02 ENE 1990
FECHA DE EMISION 10 FEB 2022
FECHA DE VENCIMIENTO 10 FEB 2032
RUN 22.222.222-2`;

const CEDULA_FRENTE_VENCIDA = `CEDULA DE IDENTIDAD
APELLIDOS
FUENTES VERA
NOMBRES
CARLOS ANDRES
FECHA DE NACIMIENTO 15/03/1985
FECHA DE VENCIMIENTO 20/07/2024
RUN 15.432.198-K`;

const CEDULA_REVERSO_MRZ = `Nació en: SANTIAGO
Profesión: OPERADOR
INCHL2222222223<<<<<<<<<<<<<<<
9001023F3202105CHL22222222<2<9
GONZALEZ<ROJAS<<MARIA<JOSE<<<<`;

const ANTECEDENTES_LIMPIO = `CERTIFICADO DE ANTECEDENTES
PARA FINES ESPECIALES
REGISTRO GENERAL DE CONDENAS
Nombre: JUAN PABLO PEREZ SOTO
RUN: 12.345.678-5
Fecha de emisión: 01/06/2026
SIN ANTECEDENTES`;

const ANTECEDENTES_CON_ANOTACIONES = `CERTIFICADO DE ANTECEDENTES
Nombre: PEDRO ANTONIO MUÑOZ DIAZ
RUN 11.111.111-1
REGISTRA ANTECEDENTES
Causa ROL 1234-2019`;

const CREDENCIAL_RIGGER = `CHILEVALORA
CERTIFICADO DE COMPETENCIAS LABORALES
Se certifica que JUAN PABLO PEREZ SOTO, RUT 12.345.678-5
es competente en el perfil RIGGER / MANIOBRISTA DE IZAJE (B30.9)
Vigencia: 15/08/2023 al 15/08/2027`;

const RUIDO_OCR = `||| ~~ Ro Xt  :: ..
FOTO OFICIAL Completo Adolfo
0 0 0 l1l1 ___`;

/** Textos completos que pasan por parseExtractedText, splitCvIntoSections y calculateExperienceFromSections. */
const documentos = {
  cv_rigger: CV_RIGGER,
  cv_soldador: CV_SOLDADOR,
  cv_operador: CV_OPERADOR,
  cv_dos_columnas: CV_DOS_COLUMNAS,
  cv_con_instituciones: CV_CON_INSTITUCIONES,
  cv_sin_secciones: CV_SIN_SECCIONES,
  cv_meses_abreviados: CV_MESES_ABREVIADOS,
  cedula_frente_vigente: CEDULA_FRENTE_VIGENTE,
  cedula_frente_vencida: CEDULA_FRENTE_VENCIDA,
  cedula_reverso_mrz: CEDULA_REVERSO_MRZ,
  antecedentes_limpio: ANTECEDENTES_LIMPIO,
  antecedentes_con_anotaciones: ANTECEDENTES_CON_ANOTACIONES,
  credencial_rigger: CREDENCIAL_RIGGER,
  ruido_ocr: RUIDO_OCR,
  cv_y_cedula_combinados: `${CV_OPERADOR}\n\n${CEDULA_FRENTE_VENCIDA}`,
  solo_espacios: "   \n  \n ",
  vacio: "",
};

const nombres = [
  "Juan Pablo Pérez Soto",
  "MARIA JOSE GONZALEZ ROJAS",
  "Carlos Andrés Fuentes Vera",
  "José Miguel De la Fuente",
  "Ana Belén Torres",
  "Luis",
  "Ñuño Ñandú",
  "Universidad Adolfo Ibáñez",
  "Constructora Miguel Morales",
  "Adolfo Ibáñez",
  "Ingeniero Constructor",
  "Curriculum Vitae",
  "Experiencia Laboral",
  "Republica De Chile",
  "Cedula De Identidad",
  "Nombre Completo",
  "Foto Oficial",
  "Ro Xt",
  "Juan123 Pérez",
  "juan.perez@example.invalid",
  "Pasaje Los Aromos",
  "Servicio De Registro Civil",
  "Gerente General",
  "Minera Ficticia Uno",
  "Pedro Antonio Muñoz Díaz",
  "Bernardo O'Higgins",
  "Arturo Prat",
  "Lampa",
  "",
  "   ",
  null,
  undefined,
  42,
];

const elecciones = [
  {
    candidatos: [
      "Juan Perez",
      "Juan Pablo Perez Soto",
      "Universidad Adolfo Ibáñez",
    ],
    referencia: null,
  },
  {
    candidatos: ["Maria Gonzalez", "Pedro Muñoz Diaz"],
    referencia: "maria.gonzalez@example.invalid",
  },
  {
    candidatos: ["Carlos Fuentes", "Carlos Andres Fuentes Vera"],
    referencia: "Carlos Andrés Fuentes Vera",
  },
  {
    candidatos: ["Constructora Miguel Morales", "Ingeniero Constructor"],
    referencia: null,
  },
  { candidatos: [], referencia: "Juan Pablo Perez" },
  { candidatos: ["", null, "Ana Torres"], referencia: null },
];

const textosConFechas = [
  "Nació el 02/01/1990 y emitió el 10-02-2022",
  "Fecha 2022.02.10 y 1990/1/2",
  "15 de marzo de 1985",
  "02 ENE 1990 / 10 FEB 2032",
  "31/02/2020 y 99/99/2020",
  "Setiembre 2019 – sept. 2021",
  "15 MAR 2020, 3-ABR-2021, 7.AGO.2022 y 1 DIC 2023",
  "sin fechas aquí",
  "",
];

const fechasChilenas = [
  "02/01/1990",
  "2/1/1990",
  "02-01-1990",
  "1990-01-02",
  "02 ENE 1990",
  "2 de enero de 1990",
  "02 de Enero del 1990",
  "10 FEB 2032",
  "31/02/2020",
  "29/02/2024",
  "29/02/2023",
  "00/01/2020",
  "15/13/2020",
  "Vence: 10/05/2030",
  "texto",
  "",
  null,
];

const ruts = [
  "12.345.678-5",
  "12345678-5",
  "123456785",
  "12.345.678-4",
  "15.432.198-K",
  "15.432.198-k",
  "11.111.111-1",
  "22.222.222-2",
  "1.234.567-4",
  "7.654.321-6",
  "999.999-9",
  "1234567",
  "1234",
  "abc",
  "",
  null,
];

const textos = [
  "  José Ñandú-Pérez, 3° ",
  "MARÍA   josé   GONZÁLEZ",
  "<script>alert('x')</script> & \"y\"",
  "Línea\ncon\tsaltos",
  "",
  null,
];

module.exports = {
  documentos,
  nombres,
  elecciones,
  textosConFechas,
  fechasChilenas,
  ruts,
  textos,
};
