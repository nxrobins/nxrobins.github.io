/* ═══════════════════════════════════════════════════════════════════════════
   PREAM Portfolio — Interactions
   ═══════════════════════════════════════════════════════════════════════════ */

// Scroll reveal for project cards
const observer = new IntersectionObserver(
    (entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
                observer.unobserve(entry.target);
            }
        });
    },
    { threshold: 0.1, rootMargin: '0px 0px -50px 0px' }
);

document.querySelectorAll('.project').forEach((el) => observer.observe(el));

// Typing animation in the cursor block
const phrases = [
    'build the substrate',
    'verify the proof',
    'prompt is medium',
    'agents write sigil',
    'compress, consolidate, emerge',
];

const typedEl = document.querySelector('.typed');
let phraseIndex = 0;
let charIndex = 0;
let deleting = false;
let pauseMs = 0;

function tick() {
    const phrase = phrases[phraseIndex];

    if (!deleting) {
        typedEl.textContent = phrase.slice(0, charIndex + 1);
        charIndex++;
        if (charIndex === phrase.length) {
            deleting = true;
            pauseMs = 2000;
        } else {
            pauseMs = 60 + Math.random() * 40;
        }
    } else {
        typedEl.textContent = phrase.slice(0, charIndex - 1);
        charIndex--;
        if (charIndex === 0) {
            deleting = false;
            phraseIndex = (phraseIndex + 1) % phrases.length;
            pauseMs = 400;
        } else {
            pauseMs = 30;
        }
    }

    setTimeout(tick, pauseMs);
}

// Start after a brief delay
setTimeout(tick, 1200);
