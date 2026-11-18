import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { useUpdateStore } from '../../services/update/store.js'
import { readApplicationVersion } from '../../services/update/version.js'
import logoDark from '../../assets/brand/aurora-512.png'
import logoLight from '../../assets/brand/aurora-light-512.png'
import styles from './Settings.module.css'
import { UpdateSection } from './UpdateSection.js'

const UPSTREAM_URL = 'https://github.com/deepseek-ai/chat-demo'
const OFFICIAL_DEMO_URL = 'https://cdn.deepseek.com/chat-demo'
const OFFICIAL_DEMO_LABEL = 'cdn.deepseek.com/chat-demo'
const MAINTAINER_URL = 'https://github.com/qeggs-dev'
const MAINTAINER_LABEL = 'github.com/qeggs-dev'

const UPSTREAM_REPO_LABEL = 'github.com/deepseek-ai/chat-demo'

const PROJECT_LICENSE = "MIT License\r\n\r\nCopyright (c) 2026 Qeggs (https://github.com/qeggs-dev) and Aurora Chat contributors\r\n\r\nPermission is hereby granted, free of charge, to any person obtaining a copy\r\nof this software and associated documentation files (the \"Software\"), to deal\r\nin the Software without restriction, including without limitation the rights\r\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\r\ncopies of the Software, and to permit persons to whom the Software is\r\nfurnished to do so, subject to the following conditions:\r\n\r\nThe above copyright notice and this permission notice shall be included in all\r\ncopies or substantial portions of the Software.\r\n\r\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\r\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\r\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\r\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\r\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\r\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\r\nSOFTWARE."

const UPSTREAM_LICENSE = `MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.`

/** 当前实际生效的主题（跟随系统时读取 prefers-color-scheme） */
const useResolvedTheme = (): 'light' | 'dark' => {
  const preference = useSettings((state) => state.themePreference)
  const [osDark, setOsDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (event: MediaQueryListEvent) => setOsDark(event.matches)
    query.addEventListener('change', handler)
    return () => query.removeEventListener('change', handler)
  }, [])
  return preference === 'system' ? (osDark ? 'dark' : 'light') : preference
}

/**
 * 「关于」分组：版本、检查更新、非官方声明、上游项目与许可。
 * 检查更新区块拆在 UpdateSection，便于单独维护状态机 UI。
 */
export const AboutSection = () => {
  const t = useTranslate()
  const version = useUpdateStore((state) => state.currentVersion) || readApplicationVersion()
  const theme = useResolvedTheme()
  return (
    <div className={styles.about}>
      <div className={styles.aboutHeader}>
        <img
          className={styles.aboutLogo}
          src={theme === 'dark' ? logoDark : logoLight}
          alt=""
          width={44}
          height={44}
        />
        <span className={styles.aboutName}>{t('appName')}</span>
        <span className={styles.aboutBadge}>{t('aboutBadge')}</span>
        {version ? (
          <span className={styles.aboutVersion}>
            {t('aboutVersionLabel')} {version}
          </span>
        ) : null}
      </div>
      <UpdateSection />
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutDisclaimerTitle')}</div>
        <p className={styles.aboutText}>{t('aboutDisclaimer')}</p>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutUpstreamLabel')}</div>
        <a className={styles.aboutLink} href={UPSTREAM_URL} target="_blank" rel="noreferrer noopener">
          {UPSTREAM_REPO_LABEL}
        </a>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutOfficialDemoLabel')}</div>
        <a
          className={styles.aboutLink}
          href={OFFICIAL_DEMO_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          {OFFICIAL_DEMO_LABEL}
        </a>
        <p className={styles.aboutText}>{t('aboutOfficialDemoNote')}</p>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutMaintainerLabel')}</div>
        <a className={styles.aboutLink} href={MAINTAINER_URL} target="_blank" rel="noreferrer noopener">
          {MAINTAINER_LABEL}
        </a>
        <p className={styles.aboutText}>{t('aboutMaintainerNote')}</p>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutLicenseLabel')}</div>
        <pre className={styles.aboutLicense}>{PROJECT_LICENSE}</pre>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutUpstreamLicenseLabel')}</div>
        <pre className={styles.aboutLicense}>{UPSTREAM_LICENSE}</pre>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutIconsLabel')}</div>
        <p className={styles.aboutText}>{t('aboutIconsText')}</p>
      </div>
      <div className={styles.aboutBlock}>
        <div className={styles.aboutLabel}>{t('aboutThirdPartyLabel')}</div>
        <p className={styles.aboutText}>{t('aboutThirdPartyText')}</p>
      </div>
    </div>
  )
}
