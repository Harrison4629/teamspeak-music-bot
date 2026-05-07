<template>
  <AvatarUpload v-model="avatarDataUrl" />
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import axios from 'axios';
import AvatarUpload from './AvatarUpload.vue';

const props = defineProps<{ botId: string }>();
const avatarDataUrl = ref<string | null>(null);
let initializing = true;

async function loadCurrent() {
  try {
    const res = await axios.get(`/api/bot/${props.botId}/avatar`, { responseType: 'blob' });
    const blob = res.data as Blob;
    avatarDataUrl.value = await blobToDataUrl(blob);
  } catch (err: any) {
    if (err?.response?.status !== 404) {
      console.warn('failed to load avatar', err);
    }
    avatarDataUrl.value = null;
  } finally {
    initializing = false;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

watch(avatarDataUrl, async (newVal, oldVal) => {
  if (initializing) return;
  if (newVal === oldVal) return;
  try {
    if (newVal && newVal.startsWith('data:')) {
      await axios.put(`/api/bot/${props.botId}/avatar`, { dataUrl: newVal });
    } else if (newVal === null) {
      await axios.delete(`/api/bot/${props.botId}/avatar`);
    }
  } catch (err) {
    console.warn('avatar update failed', err);
  }
});

onMounted(loadCurrent);
</script>
