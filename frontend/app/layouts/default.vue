<template>
  <div class="shell">
    <!-- Header -->
    <header class="header">
      <div class="header-left">
        <button class="brand" @click="navigateTo('/')">
          <div class="brand-mark">
            <img v-if="showBrandImage" :src="brandLogo" alt="Eggfans" class="brand-logo" @error="showBrandImage = false" />
            <span v-else class="brand-fallback">E</span>
          </div>
          <div class="brand-text">
            <span class="brand-name">Eggfans</span>
            <span class="brand-sub">Eggfans Studio</span>
          </div>
        </button>
      </div>

      <nav class="header-nav">
        <NuxtLink to="/" class="nav-link" :class="{ active: route.path === '/' }">
          <LayoutGrid :size="15" :stroke-width="1.8" />
          <span>项目</span>
        </NuxtLink>
        <NuxtLink to="/assets" class="nav-link" :class="{ active: route.path === '/assets' }">
          <Images :size="15" :stroke-width="1.8" />
          <span>资产库</span>
        </NuxtLink>
        <NuxtLink to="/settings" class="nav-link" :class="{ active: route.path === '/settings' }">
          <Settings :size="15" :stroke-width="1.8" />
          <span>设置</span>
        </NuxtLink>
      </nav>

      <div class="header-right">
        <div class="film-strip">
          <span class="film-frame"></span>
          <span class="film-frame"></span>
          <span class="film-frame"></span>
        </div>
      </div>
    </header>

    <main class="content">
      <slot />
    </main>
  </div>
</template>

<script setup>
import { Images, LayoutGrid, Settings } from 'lucide-vue-next'
import brandLogo from '~/assets/eggfans-logo.png'

const route = useRoute()
const showBrandImage = ref(true)
</script>

<style scoped>
.shell {
  display: flex; flex-direction: column;
  height: 100vh; overflow: hidden;
  background: var(--bg-base);
}

/* === Header === */
.header {
  display: flex; align-items: center;
  height: 56px; flex-shrink: 0;
  padding: 0 24px;
  background: var(--bg-1);
  border-bottom: 1px solid var(--border);
  gap: 32px;
}

.header-left { display: flex; align-items: center; }

.brand {
  display: flex; align-items: center; gap: 10px;
  background: none; border: none; cursor: pointer; padding: 0;
  text-decoration: none; border-radius: var(--radius);
  transition: opacity 0.15s;
}
.brand:hover { opacity: 0.75; }
.brand-mark {
  width: 32px; height: 32px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-2); border-radius: var(--radius);
  border: 1px solid var(--border);
  overflow: hidden;
}
.brand-logo {
  width: 22px;
  height: 22px;
  object-fit: contain;
  display: block;
}
.brand-fallback {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  color: var(--accent-text);
  line-height: 1;
}
.brand-text { display: flex; flex-direction: column; align-items: flex-start; line-height: 1; }
.brand-name {
  font-family: var(--font-display);
  font-size: 15px; font-weight: 700;
  color: var(--text-0);
  letter-spacing: -0.01em;
}
.brand-sub {
  font-size: 10px; font-weight: 400;
  color: var(--text-3); margin-top: 1px;
  letter-spacing: 0.04em;
}

/* Nav */
.header-nav { display: flex; gap: 4px; flex: 1; }
.nav-link {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 14px; border-radius: var(--radius);
  font-size: 13px; font-weight: 500;
  color: var(--text-2); text-decoration: none;
  transition: all 0.18s var(--ease-out);
  border: 1px solid transparent;
}
.nav-link:hover {
  background: var(--bg-hover); color: var(--text-0);
  border-color: var(--border);
}
.nav-link.active {
  background: var(--accent-bg);
  color: var(--accent-text);
  border-color: rgba(76,125,255,0.18);
  font-weight: 600;
}

.header-right { display: flex; align-items: center; margin-left: auto; }

/* Film strip decoration */
.film-strip {
  display: flex; align-items: center; gap: 3px;
  padding: 6px 10px;
  background: var(--bg-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.film-frame {
  width: 8px; height: 10px;
  background: var(--bg-3);
  border-radius: 1.5px;
  transition: background 0.2s;
}
.film-frame:nth-child(2) { background: var(--accent); opacity: 0.6; }
.film-frame:nth-child(3) { opacity: 0.3; }

/* Content */
.content { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
</style>
