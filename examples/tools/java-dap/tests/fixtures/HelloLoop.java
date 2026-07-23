// Debug-target fixture: a couple of named threads and a slow main loop, so the
// adapter has something to enumerate, suspend, and (in M2+) set breakpoints in.
public class HelloLoop {
    static int counter = 0;

    public static void main(String[] args) throws Exception {
        Thread worker = new Thread(HelloLoop::work, "worker-thread");
        worker.setDaemon(true);
        worker.start();

        for (int i = 0; i < 120; i++) {
            counter = bump(counter);
            System.out.println("tick " + counter);
            Thread.sleep(500);
        }
    }

    static int bump(int n) {
        return n + 1;
    }

    static void work() {
        while (true) {
            try {
                Thread.sleep(1000);
            } catch (InterruptedException e) {
                return;
            }
        }
    }
}
