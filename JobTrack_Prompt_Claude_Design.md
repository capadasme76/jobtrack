Diseña un sitio web y dashboard para JobTrack, una herramienta que organiza la búsqueda de empleo de profesionales ejecutivos en un solo lugar (pipeline de postulaciones, red de contactos, match de CV contra vacantes, cartas de presentación). El usuario principal es un director/gerente en búsqueda activa de un nuevo cargo — perfil senior, profesional, sin tiempo que perder.

## Páginas a diseñar

**1. Home (landing pública)**
- Header fijo arriba: logo "JobTrack" a la izquierda, botones "Iniciar sesión" y "Crear cuenta" a la derecha.
- Hero: titular corto y directo (ej. "Organiza tu búsqueda de empleo en un solo lugar"), una bajada de 1-2 líneas explicando el valor, y un botón de llamado a la acción grande ("Crear cuenta gratis").
- Debajo del hero: 3-4 bloques cortos mostrando las funciones clave (pipeline de postulaciones, red de contactos, match de CV, seguimiento de entrevistas), cada uno con ícono + título corto + una frase.
- Footer simple.

**2. Login / Crear cuenta**
- Formulario centrado, minimalista: email + contraseña. Link cruzado entre ambas pantallas ("¿No tienes cuenta? Créala aquí").

**3. Dashboard (después de iniciar sesión)**
- Layout de aplicación con **sidebar fijo a la izquierda** (no navegación horizontal): logo arriba, nombre del usuario, y 8 ítems de navegación con ícono: Mi perfil, Hoy, Pipeline, Red de contactos, Reuniones, Match CV, Métricas, Portales.
- Área principal a la derecha con encabezado simple (título de sección + fecha) y el contenido organizado en **módulos/tarjetas** independientes (fondo blanco, borde sutil, esquinas redondeadas, sombra suave) — nunca texto corrido de borde a borde.
- Dentro del dashboard: tarjetas de tipo kanban para el pipeline (columnas por estado), tabla compacta para contactos, tarjetas de estadísticas (números grandes + etiqueta), y un layout de dos columnas en la sección de perfil (contenido principal a la izquierda, panel lateral con datos secundarios a la derecha — estilo página de producto de e-commerce).

## Sistema de diseño

**Colores:**
- Fondo general: blanco / gris muy claro (#F4F7FB)
- Superficie de tarjetas: blanco puro (#FFFFFF)
- Color de marca / acento único (botones, links, estado activo del sidebar): azul (#185FA5, variante oscura #0C447C)
- Texto principal: casi negro con tinte azulado (#0F1B2D)
- Texto secundario: gris azulado medio (#4C5A70)
- Bordes: gris azulado muy claro (#DCE6F0)
- Colores de estado (usar con moderación, solo para badges): verde (#0EA672) para éxito/verificado, ámbar (#E2851A) para alertas/pendientes

**Tipografía:**
- Titulares: serif con carácter (tipo Fraunces o similar), peso 700
- Cuerpo y UI: sans-serif neutra (tipo Inter), peso 400-600
- Texto de ayuda/etiquetas: mono para un toque técnico sutil (tipo IBM Plex Mono), solo en detalles pequeños

**Principios de layout:**
- Contenido siempre contenido en un ancho máximo (~1100px), nunca de borde a borde
- Todo vive en módulos/tarjetas visualmente separados, no texto flotando directo sobre el fondo
- Mínimo texto explicativo — preferir etiquetas cortas y tooltips sobre párrafos largos
- Un solo color de acento usado con disciplina para botones y estados activos — el resto en escala de grises/azules neutros
- Referencias de estilo: Linear, Stripe, Attio, Shopify (admin) — calma, orden, jerarquía clara, nada de decoración innecesaria
