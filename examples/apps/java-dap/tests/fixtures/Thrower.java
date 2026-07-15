public class Thrower {
    public static void main(String[] args) {
        System.out.println("start");
        int x = compute();
        System.out.println(x);
    }

    static int compute() {
        String s = null;
        return s.length(); // uncaught NullPointerException
    }
}
