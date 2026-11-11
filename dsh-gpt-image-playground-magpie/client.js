/**
 * dsh-gpt-image-playground-magpie — browser half.
 *
 * Adds one API configuration to the GPT Image Playground workbench: magpie's
 * 幻灵AI image models behind this bundle's same-origin route. The vendored app
 * keeps its configurations in its own browser storage and imports one from its
 * documented URL parameters (`profileId`, `apiUrl`, `model`, ...), so the first
 * time the workbench frame appears without that configuration, the frame is
 * pointed at the same app URL with those parameters. The app imports the
 * configuration, asks the user to confirm when its settings change, and strips
 * the parameters from its address.
 *
 * Runs once per SEED_VERSION: a configuration the user later edits or deletes
 * is left alone.
 */

window.__ModuleLoader__.load({
  id: 'dsh-gpt-image-playground-magpie',
  factory() {
    const APP_PATH = '/plugins/dsh-gpt-image-playground/app/'
    const APP_SRC = `${APP_PATH}index.html`
    const ROUTE = '/plugins/dsh-gpt-image-playground-magpie/v1'
    const PROFILE_ID = 'magpie-huanling'
    const PROFILE_NAME = '幻灵AI · magpie'
    const MODELS = ['ai/gpt-image-2.6-sunburst', 'ai/gpt-image-2.6-flare']
    // The app refuses a configuration without a key; the Host route drops this one.
    const PLACEHOLDER_KEY = 'magpie-local'
    const APP_STORE_KEY = 'gpt-image-playground'
    const SEED_KEY = 'dsh-gpt-image-playground-magpie:seeded'
    const SEED_VERSION = '1'

    function readStorage(key) {
      try {
        return window.localStorage.getItem(key)
      } catch {
        return null
      }
    }

    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(key, value)
      } catch {
        /* storage unavailable: the seed simply runs again next time */
      }
    }

    /** The app persists `{ state: { settings: { profiles } } }` under APP_STORE_KEY. */
    function profileExists() {
      const raw = readStorage(APP_STORE_KEY)
      if (!raw) return false
      try {
        const profiles = JSON.parse(raw)?.state?.settings?.profiles
        return Array.isArray(profiles) && profiles.some((profile) => profile && profile.id === PROFILE_ID)
      } catch {
        return false
      }
    }

    function importUrl() {
      const params = new URLSearchParams({
        profileId: PROFILE_ID,
        profileName: PROFILE_NAME,
        apiUrl: `${window.location.origin}${ROUTE}`,
        apiKey: PLACEHOLDER_KEY,
        model: MODELS.join(','),
        apiMode: 'images',
      })
      return `${APP_SRC}?${params}`
    }

    function findWorkbenchFrame() {
      for (const frame of document.querySelectorAll('iframe')) {
        if ((frame.getAttribute('src') ?? '').startsWith(APP_PATH)) return frame
      }
      return undefined
    }

    function apply(ctx) {
      ctx.effect(() => {
        if (readStorage(SEED_KEY) === SEED_VERSION) return () => {}
        if (profileExists()) {
          writeStorage(SEED_KEY, SEED_VERSION)
          return () => {}
        }
        let done = false
        let scheduled = 0
        const observer = new MutationObserver(() => {
          if (scheduled !== 0) return
          scheduled = window.requestAnimationFrame(() => {
            scheduled = 0
            seed()
          })
        })
        function seed() {
          if (done) return
          const frame = findWorkbenchFrame()
          if (frame === undefined) return
          done = true
          observer.disconnect()
          writeStorage(SEED_KEY, SEED_VERSION)
          frame.setAttribute('src', importUrl())
        }
        // The workbench frame mounts only when its panel is first opened.
        observer.observe(document.body, { childList: true, subtree: true })
        seed()
        return () => {
          observer.disconnect()
          if (scheduled !== 0) window.cancelAnimationFrame(scheduled)
        }
      }, 'dsh-gpt-image-playground-magpie: seed configuration')
    }

    return { inject: [], apply }
  },
})
