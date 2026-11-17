import { useTranslate } from '../../i18n/index.js'
import {
  describeReadAloudError,
  toggleReadAloud,
  useReadAloud,
} from '../../services/speech/readAloud.js'
import { IconPlayMediaOutline16 } from '../base/icons.js'
import { PackIcon } from '../base/PackIcon.js'
import { STYLE_SLOTS } from '../../services/style/types.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { ReadingBars } from './ReadingBars.js'

/** 朗读按钮：未朗读时点击开始，加载中或朗读中点击停止；正文原样提交，由服务端过滤 markdown */
export const ReadAloudButton = ({ messageId, text }: { messageId: string; text: string }) => {
  const t = useTranslate()
  const status = useReadAloud((state) => (state.messageId === messageId ? state.status : 'idle'))
  return (
    <IconButton
      icon={
        status === 'idle' ? (
          <PackIcon slot={STYLE_SLOTS.iconPlay} size={16} fallback={<IconPlayMediaOutline16 />} />
        ) : (
          <ReadingBars mode={status} />
        )
      }
      tooltip={status === 'idle' ? t('ttsPlay') : t('ttsStop')}
      tooltipPlacement="bottom"
      onClick={() =>
        toggleReadAloud(messageId, text, (error) => showToast(describeReadAloudError(error)))
      }
    />
  )
}
