<template>
  <div class="password-login">
    <form v-if="phase === 'form' || phase === 'submitting'" class="form" @submit.prevent="submit">
      <label class="field">QQ 号<Input v-model.trim="uin" :class="FIELD" inputmode="numeric" autocomplete="off" maxlength="12" :disabled="locked" /></label>
      <label class="field"
        >密码<Input v-model="password" :class="FIELD" type="password" autocomplete="new-password" maxlength="128" :disabled="locked"
      /></label>
      <Alert v-if="state.error" variant="destructive" as="p" role="alert">{{ state.error }}</Alert>
      <Alert v-else-if="state.notice && phase === 'form'" as="p" role="status">{{ state.notice }}</Alert>
      <Alert v-if="!available" variant="warn" as="p" role="status">QQ 登录服务暂时不可用，恢复后即可登录。</Alert>
      <div class="row">
        <Button type="submit" variant="default" :disabled="locked || !valid">{{ phase === "submitting" ? "正在登录…" : "登录" }}</Button>
      </div>
    </form>

    <div v-else-if="phase === 'device'" class="device">
      <div class="qr-frame">
        <img class="qr-image" :src="deviceImage" alt="QQ 新设备验证二维码，请用已登录该账号的手机 QQ 扫码" />
      </div>
      <div class="copy">
        <h3>{{ state.scanned ? "请在手机上确认" : "确认新设备" }}</h3>
        <p class="muted">{{ state.notice }}</p>
        <div class="row">
          <Button variant="outline" @click="model.renewDevice()">重新获取验证码</Button>
          <Button variant="ghost" @click="model.cancel()">取消</Button>
        </div>
      </div>
    </div>

    <div v-else class="copy waiting" role="status">
      <h3>{{ phase === "captcha" ? "安全验证" : "正在登录" }}</h3>
      <p class="muted">{{ state.notice }}</p>
      <div class="row">
        <Button variant="ghost" @click="model.cancel()">{{ phase === "submitted" ? "重新填写" : "取消" }}</Button>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import { computed, ref } from "vue";

import type { createQQPasswordLogin } from "../state/qq-password-login";
import { Alert } from "./ui/alert";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const FIELD = "rounded-[10px] border-transparent bg-group-tile shadow-none dark:bg-group-tile";
const props = defineProps<{ model: ReturnType<typeof createQQPasswordLogin>; available: boolean }>();
const state = props.model.state;
const phase = computed(() => state.phase);
const uin = ref("");
const password = ref("");
const locked = computed(() => phase.value === "submitting" || !props.available);
const valid = computed(() => /^[1-9]\d{4,11}$/.test(uin.value) && password.value.length > 0);
/** The verification code is a local PNG data URL from the server; anything else is not rendered. */
const deviceImage = computed(() => (/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(state.deviceImage) ? state.deviceImage : ""));

function submit() {
  if (locked.value || !valid.value) return;
  const secret = password.value;
  password.value = "";
  void props.model.submit(uin.value, secret);
}
</script>

<style scoped>
/* UI-EXCEPTION qr-media: the device-confirmation code keeps a white scan background, like the login QR. */
@reference "../styles/app.css";

.password-login {
  display: grid;
}
.form {
  display: grid;
  gap: 16px;
  max-width: 380px;
}
.copy {
  display: grid;
  gap: 12px;
  justify-items: start;
}
.copy h3 {
  @apply text-base font-semibold;
}
.device {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 24px;
  align-items: center;
}
.qr-frame {
  @apply rounded-xl;
  width: 220px;
  height: 220px;
  padding: 12px;
  background: #fff;
  display: grid;
  place-items: center;
}
.qr-image {
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}
@media (max-width: 640px) {
  .device {
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
  }
  .qr-frame {
    width: min(232px, 100%);
    height: auto;
    aspect-ratio: 1;
  }
}
</style>
