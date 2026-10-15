import type { UserImage } from './types.js'

export const MAX_USER_IMAGES = 4
export const MAX_USER_IMAGE_BYTES = 1024 * 1024
export const MAX_USER_IMAGES_BYTES = 1024 * 1024

const invalid = (): never => { throw new Error('Invalid user images: expected bounded inline PNG or JPEG data') }
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 校验传输数据，不解析 URL，也不在错误中暴露图像内容。
 * 宿主在构造此值之前会单独校验所选文件的格式。 */
export function validateUserImages(images: unknown): asserts images is UserImage[] {
  if (!Array.isArray(images) || images.length > MAX_USER_IMAGES) return invalid()
  let total = 0
  for (const image of images) {
    if (image === null || typeof image !== 'object' || Array.isArray(image) ||
        Object.keys(image).some(key => key !== 'mimeType' && key !== 'dataUrl') ||
        !['image/png', 'image/jpeg'].includes(image.mimeType) || typeof image.dataUrl !== 'string') return invalid()
    const prefix = `data:${image.mimeType};base64,`
    if (!image.dataUrl.startsWith(prefix) || image.dataUrl.length > prefix.length + Math.ceil(MAX_USER_IMAGE_BYTES / 3) * 4) return invalid()
    const data = image.dataUrl.slice(prefix.length)
    if (!data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return invalid()
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
    // 未使用位非零属于非规范编码，不得为提交摘要绑定的
    // 精确图像字节产生别名。
    if (padding === 2 && (alphabet.indexOf(data[data.length - 3]!) & 15) !== 0 ||
        padding === 1 && (alphabet.indexOf(data[data.length - 2]!) & 3) !== 0) return invalid()
    const bytes = data.length / 4 * 3 - padding
    if (bytes <= 0 || bytes > MAX_USER_IMAGE_BYTES) return invalid()
    total += bytes
    if (total > MAX_USER_IMAGES_BYTES) return invalid()
  }
}
