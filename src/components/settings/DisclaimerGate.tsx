import { useTranslate } from '../../i18n/index.js'
import { acceptDisclaimer, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { ensureApiKey } from './settingsDialogState.js'
import styles from './DisclaimerGate.module.css'

const UPSTREAM_URL = 'https://github.com/deepseek-ai/chat-demo'

/**
 * 首次使用必须先确认的声明：本应用与官方无关，是社区基于 chat-demo 修改而成。
 * 确认结果写入 localStorage，之后不再弹出；设置 → 关于 里可随时查看完整内容。
 */
export const DisclaimerGate = () => {
  const t = useTranslate()
  const accepted = useSettings((state) => state.disclaimerAccepted)
  if (accepted) {
    return null
  }
  return (
    <Modal
      title={t('disclaimerGateTitle')}
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={() => {}}
      footer={
        <Button size="m" onClick={() => {
            acceptDisclaimer()
            // 没有 API Key 时直接打开设置，避免确认完停在空页面
            ensureApiKey()
          }}>
          {t('disclaimerGateAccept')}
        </Button>
      }
    >
      <p className={styles.lead}>{t('disclaimerGateLead')}</p>
      <ul className={styles.points}>
        <li>{t('disclaimerGatePointNotOfficial')}</li>
        <li>{t('disclaimerGatePointCommunity')}</li>
        <li>{t('disclaimerGatePointLicense')}</li>
      </ul>
      <p className={styles.note}>
        {t('disclaimerGateUpstreamLabel')}
        <a className={styles.link} href={UPSTREAM_URL} target="_blank" rel="noreferrer noopener">
          github.com/deepseek-ai/chat-demo
        </a>
      </p>
      <p className={styles.note}>{t('disclaimerGateAfter')}</p>
    </Modal>
  )
}
